// Application HTTP handler for the CET StudyHack reading lab + score estimator.
//
// Routes are selected by the `action` query parameter so they work regardless
// of the physical Function path prefix the gateway forwards. The browser only
// ever sends prompt text / structured lab input / a computed reference
// estimate; all Cloud resource IDs and the PAT stay server-side.
//
// Reading lab actions (short requests, each well inside the ~60s SSE window):
//   train    -> strict JSON evidence diagnosis for the current question
//   explain  -> one on-demand section (translation | vocab | grammar), streamed
//   transfer -> a vetted same-error-type verification question from the bank
// Estimator actions:
//   grade    -> short strict JSON writing/translation feedback (with materials)
//   recommend-> RAG retrieval over the built-in corpus, streamed grounded notes
//
// Web-standard Request/Response/ReadableStream so the same handler runs on the
// deployed Deno edge runtime and on a local Node fixture runner.

import { readSSE } from './sse.mjs';
import {
  buildToolSystemPrompt, buildExplainUserPrompt,
  buildTrainSystemPrompt, buildTrainUserPrompt,
  buildEstimatorSystemPrompt, buildGradePrompt, buildRecommendPrompt,
} from './prompt.mjs';
import { ensureResources } from './resources.mjs';
import { retrieve, formatContext } from './rag.mjs';
import { pickTransfer } from './lab-bank.mjs';

const MIN_EXPLAIN = 20;
const MAX_EXPLAIN = 6000;
const MAX_SENTENCES = 60;
const MAX_SENTENCE_CHARS = 600;
const MAX_LAB_TOTAL = 15000;
const MAX_ESSAY = 4000;
const MIN_ESSAY = 10;
const MAX_PROMPT_MATERIAL = 2000;
const MAX_OUTPUT = 200000;
const MAX_STREAM_MS = 120000;
const MAX_CONCURRENT = 4;
const RATE_WINDOW_MS = 600000;
const RATE_MAX = 12;
const MODULE_KEYS = ['listening', 'reading', 'writing', 'translation'];
const EXPLAIN_SECTIONS = ['translation', 'vocab', 'grammar'];
const TRAIN_TYPES = new Set([
  'scope_expansion', 'causal_inversion', 'attitude_shift', 'detail_mismatch',
  'not_supported', 'evidence_insufficient', 'right_answer_wrong_evidence',
  'right_answer_uncertain', 'none',
]);

// Each profile keeps its own scope. The system prompt is fixed per Agent, so
// the generic tool contract and the JSON diagnosis contract live in separate
// scopes rather than fighting over one cached Agent.
const TOOL_PROFILE = {
  scope: 'cet-reading-tool:prod:cn',
  envName: 'CET Reading Tool Environment',
  agentName: '四六级阅读备考工具',
  metadata: { app: 'cet-reading-tool' },
  purpose: 'reading-tool',
};
const TRAIN_PROFILE = {
  scope: 'cet-reading-train:prod:cn',
  envName: 'CET Reading Train Environment',
  agentName: '四六级阅读错因诊断',
  metadata: { app: 'cet-reading-train' },
  purpose: 'evidence-diagnosis',
};
const ESTIMATOR_PROFILE = {
  scope: 'cet-score-estimator:prod:cn',
  envName: 'CET Score Environment',
  agentName: '四六级估分备考助手',
  metadata: { app: 'cet-score-estimator' },
  purpose: 'estimation',
};

const ERROR_MESSAGES = {
  ai_not_configured: 'AI 服务尚未配置完成，请稍后再试。',
  ai_access_denied: 'AI 服务授权失败，请联系站点管理员。',
  ai_rate_limited: 'AI 服务繁忙，请稍后再试。',
  ai_conflict: 'AI 正在处理其它请求，请稍后再试。',
  ai_initialization_conflict: 'AI 引擎初始化冲突，请联系站点管理员。',
  ai_resource_repair_required: 'AI 引擎需要维护，请联系站点管理员。',
  ai_initialization_pending: 'AI 引擎正在初始化，请稍后重试。',
  ai_initialization_rejected: 'AI 引擎初始化被拒绝，请联系站点管理员。',
  ai_service_unavailable: 'AI 服务暂时不可用，请稍后重试。',
  ai_request_unknown: 'AI 服务响应异常，请稍后重试。',
  ai_response_invalid: 'AI 返回异常，请重试。',
  ai_request_rejected: '请求被 AI 服务拒绝，请调整内容后重试。',
  ai_empty_result: 'AI 未返回有效结果，请重试。',
  ai_grade_invalid: 'AI 评分解析失败，请重试或改用手动档位。',
  ai_train_invalid: 'AI 诊断结果无法解析，请重试。',
  ai_generation_failed: 'AI 生成失败，请重试。',
  ai_terminated: '会话已结束，请重试。',
  ai_incomplete: '生成中断，请重试。',
  ai_timeout: '处理超时，内容可能不完整，请重试。',
};

function mapError(error) {
  if (error?.name === 'AbortError' || /aborted/i.test(String(error?.message))) {
    return { code: 'ai_timeout', message: ERROR_MESSAGES.ai_timeout };
  }
  const code = typeof error?.code === 'string' ? error.code : 'ai_service_unavailable';
  return { code, message: ERROR_MESSAGES[code] || '处理失败，请稍后重试。' };
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
function jsonError(code, message, status) {
  return json({ ok: false, error: code, message }, status);
}
function clientIp(request) {
  const fwd = request.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim().slice(0, 64) || 'unknown';
  return request.headers.get('x-real-ip')?.slice(0, 64) || 'unknown';
}

const bandOf = score => (score >= 11 ? 'high' : score >= 8 ? 'mid' : 'low');

// Extract the outermost JSON object, tolerating code fences / surrounding prose.
function extractJson(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const raw = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
}

// Normalize and validate the model's train reply against the exact sentence ids
// and options the browser sent. Any invented id is dropped; if the correct
// option cannot be confirmed the whole diagnosis is rejected.
function parseTrain(text, ctx) {
  const obj = extractJson(text);
  if (!obj) return null;
  const rawCorrect = typeof obj.correct_option === 'string' ? obj.correct_option.trim().toUpperCase() : '';
  const correctOption = ctx.referenceAnswer && ctx.optionKeys.has(ctx.referenceAnswer)
    ? ctx.referenceAnswer
    : ctx.optionKeys.has(rawCorrect) ? rawCorrect : null;
  if (!correctOption) return null;
  const answerCorrect = ctx.chosen === correctOption;

  const filterIds = value => (Array.isArray(value)
    ? [...new Set(value.filter(id => typeof id === 'string' && ctx.sentenceIds.has(id)))].slice(0, 4)
    : []);
  const correctEvidence = filterIds(obj.correct_evidence_ids);
  // The student's evidence is what the browser actually sent, not what the model
  // echoed back. This keeps the "your evidence" panel truthful.
  const studentEvidence = [...new Set(ctx.evidenceIds)].filter(id => ctx.sentenceIds.has(id)).slice(0, 4);

  let errorType = TRAIN_TYPES.has(obj.error_type) ? obj.error_type : (answerCorrect ? 'none' : 'detail_mismatch');
  let alignment = 'unknown';
  const overlaps = studentEvidence.some(id => correctEvidence.includes(id));
  if (answerCorrect) {
    if (!studentEvidence.length || !correctEvidence.length) {
      errorType = 'evidence_insufficient';
    } else if (!overlaps) {
      errorType = 'right_answer_wrong_evidence';
      alignment = 'misaligned';
    } else {
      alignment = 'aligned';
      errorType = ctx.confidence === 'low' ? 'right_answer_uncertain' : 'none';
    }
  } else {
    if (errorType === 'none') errorType = 'detail_mismatch';
    if (!correctEvidence.length) errorType = 'evidence_insufficient';
    alignment = overlaps ? 'aligned' : (studentEvidence.length ? 'misaligned' : 'unknown');
  }

  const diff = obj.english_diff && typeof obj.english_diff === 'object' ? obj.english_diff : {};
  const clean = value => (typeof value === 'string' ? value.trim().slice(0, 60) : '');
  const hint = typeof obj.hint === 'string' && obj.hint.trim()
    ? obj.hint.trim().slice(0, 80)
    : '回到原文核对你的依据是否直接支撑所选或正确的选项。';
  const explanation = typeof obj.explanation === 'string' ? obj.explanation.trim().slice(0, 240) : '';

  return {
    answer_correct: answerCorrect,
    chosen: ctx.chosen,
    correct_option: correctOption,
    error_type: errorType,
    student_evidence_ids: studentEvidence,
    correct_evidence_ids: correctEvidence,
    english_diff: { left: clean(diff.left), right: clean(diff.right) },
    hint,
    explanation,
    confidence: ctx.confidence,
    alignment,
  };
}

// Parse the model's strict-JSON grade reply. Material presence is decided by
// the handler (not the model), so relevance can never be upgraded without the
// corresponding essay prompt / Chinese source.
function parseGrade(text, ctx = {}) {
  const obj = extractJson(text);
  if (!obj) return null;
  const norm = (item, hasMaterial) => {
    if (!item || typeof item !== 'object') {
      return { score: null, band: null, relevance: 'not_checked', materialMissing: false, comment: '未提供有效文本' };
    }
    let score = Number(item.score);
    if (!Number.isFinite(score)) score = null;
    else score = Math.round(Math.min(15, Math.max(0, score)) * 10) / 10;
    let band = ['low', 'mid', 'high'].includes(item.band) ? item.band : null;
    if (score === null) band = null;
    else if (!band) band = bandOf(score);
    const relevance = score !== null && hasMaterial ? 'checked' : 'not_checked';
    const comment = typeof item.comment === 'string' ? item.comment.slice(0, 400) : '';
    return { score, band, relevance, materialMissing: score !== null && !hasMaterial, comment };
  };
  const writing = norm(obj.writing, Boolean(ctx.writingMaterial));
  const translation = norm(obj.translation, Boolean(ctx.translationMaterial));
  if (writing.score === null && translation.score === null) return null;
  return { writing, translation };
}

// The browser computes the reference estimate with the shared engine; validate
// its shape before using it to ground retrieval and the recommendation prompt.
// No pass probability is part of the contract anymore.
function validEstimate(e) {
  if (!e || typeof e !== 'object') return false;
  if (!Array.isArray(e.modules) || e.modules.length !== 4) return false;
  if (!e.modules.every(m => m && MODULE_KEYS.includes(m.key)
    && Number.isFinite(Number(m.score)) && Number.isFinite(Number(m.max)))) return false;
  if (!Array.isArray(e.weak) || !e.weak.length || !e.weak.every(k => MODULE_KEYS.includes(k))) return false;
  if (!Number.isFinite(Number(e.total))) return false;
  if (!Array.isArray(e.range) || e.range.length !== 2 || !e.range.every(v => Number.isFinite(Number(v)))) return false;
  if (!Number.isFinite(Number(e.gap))) return false;
  return true;
}

function cleanSentences(input) {
  if (!Array.isArray(input) || !input.length || input.length > MAX_SENTENCES) return null;
  const seen = new Set();
  const out = [];
  let total = 0;
  for (const raw of input) {
    const id = typeof raw?.id === 'string' ? raw.id.trim() : '';
    const text = typeof raw?.text === 'string' ? raw.text.trim() : '';
    if (!/^s\d{1,3}$/.test(id) || seen.has(id) || !text || text.length > MAX_SENTENCE_CHARS) return null;
    seen.add(id);
    total += text.length;
    out.push({ id, text });
  }
  if (total > MAX_LAB_TOTAL) return null;
  return out;
}

function cleanOptions(input) {
  if (!Array.isArray(input) || input.length !== 4) return null;
  const keys = new Set(['A', 'B', 'C', 'D']);
  const seen = new Set();
  const out = [];
  for (const raw of input) {
    const key = typeof raw?.key === 'string' ? raw.key.trim().toUpperCase() : '';
    const text = typeof raw?.text === 'string' ? raw.text.trim() : '';
    if (!keys.has(key) || seen.has(key) || !text || text.length > 300) return null;
    seen.add(key);
    out.push({ key, text });
  }
  return out;
}

export function createAppHandler({ cloud, mode = 'live' }) {
  let active = 0;
  const hits = new Map();

  function checkRate(ip) {
    const now = Date.now();
    const arr = (hits.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
    if (arr.length >= RATE_MAX) {
      hits.set(ip, arr);
      return { ok: false, message: '请求过于频繁，请稍后再试（每 10 分钟最多 12 次 AI 调用）。' };
    }
    arr.push(now);
    hits.set(ip, arr);
    if (hits.size > 5000) hits.delete(hits.keys().next().value);
    return { ok: true };
  }
  function releaseSlot() { if (active > 0) active -= 1; }

  function guard(request) {
    const rate = checkRate(clientIp(request));
    if (!rate.ok) return jsonError('rate_limited', rate.message, 429);
    if (active >= MAX_CONCURRENT) return jsonError('busy', '当前使用人数较多，请稍后再试。', 429);
    return null;
  }

  // Shared one-shot Session SSE runner.
  //   kind 'stream' -> project incremental Markdown (explain / recommend)
  //   kind 'grade'  -> collect text, parse strict JSON, emit result
  //   kind 'train'  -> collect text, parse + validate diagnosis JSON, emit result
  function runStream(request, { prompt, title, kind, profile, systemPrompt, runningMessage, trainContext, gradeContext }) {
    const encoder = new TextEncoder();
    const lifetime = new AbortController();
    const onAbort = () => lifetime.abort();
    request.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => lifetime.abort(), MAX_STREAM_MS);
    let upstream = null;
    let slotTaken = false;

    const stream = new ReadableStream({
      async start(controller) {
        let closed = false;
        const send = obj => {
          if (closed) return;
          try { controller.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(obj)}\n\n`)); } catch { /* closed */ }
        };
        const heartbeat = setInterval(() => {
          if (closed) return;
          try { controller.enqueue(encoder.encode(': ping\n\n')); } catch { /* closed */ }
        }, 15000);
        const finish = () => {
          if (closed) return;
          closed = true;
          clearInterval(heartbeat);
          clearTimeout(timer);
          try { controller.close(); } catch { /* already closed */ }
        };
        const terminal = out => {
          if (kind === 'train') {
            const parsed = parseTrain(out, trainContext);
            if (parsed) { send({ type: 'result', ...parsed }); send({ type: 'done', state: 'completed' }); }
            else send({ type: 'error', code: 'ai_train_invalid', message: ERROR_MESSAGES.ai_train_invalid });
          } else if (kind === 'grade') {
            const parsed = parseGrade(out, gradeContext);
            if (parsed) { send({ type: 'result', ...parsed }); send({ type: 'done', state: 'completed' }); }
            else send({ type: 'error', code: 'ai_grade_invalid', message: ERROR_MESSAGES.ai_grade_invalid });
          } else if (out && out.trim()) {
            send({ type: 'done', state: 'completed' });
          } else {
            send({ type: 'error', code: 'ai_empty_result', message: ERROR_MESSAGES.ai_empty_result });
          }
        };
        try {
          active += 1;
          slotTaken = true;
          send({ type: 'status', state: 'initializing', message: '正在准备 AI 引擎…' });
          const binding = await ensureResources(cloud, profile.scope, systemPrompt, profile);
          if (lifetime.signal.aborted) throw new Error('aborted');

          const session = await cloud.request('/api/v1/cloud/sessions', {
            method: 'POST',
            body: {
              agent: binding.agent,
              environment_id: binding.environment_id,
              title,
              metadata: { app: profile.metadata.app },
            },
          });
          const sessionId = session?.id;
          if (typeof sessionId !== 'string' || !/^sess_[A-Za-z0-9_-]+$/.test(sessionId)) {
            throw Object.assign(new Error('ai_response_invalid'), { code: 'ai_response_invalid' });
          }

          upstream = await cloud.openStream(sessionId, { signal: lifetime.signal });
          await cloud.request(`/api/v1/cloud/sessions/${sessionId}/events`, {
            method: 'POST',
            body: { events: [{ type: 'user.message', content: [{ type: 'text', text: prompt }] }] },
          });
          send({ type: 'status', state: 'running', message: runningMessage });

          let draft = '';
          let finalText = null;
          let ended = false;
          for await (const frame of readSSE(upstream.body, { signal: lifetime.signal, maxFrameChars: 262144 })) {
            let ev;
            try { ev = JSON.parse(frame.data); } catch { continue; }
            const t = ev?.type;
            if (t === 'event_delta') {
              const d = ev.delta;
              if (d?.type === 'content_delta' && d.content?.type === 'text' && typeof d.content.text === 'string') {
                if (draft.length < MAX_OUTPUT) {
                  draft += d.content.text;
                  if (kind === 'stream') send({ type: 'delta', text: d.content.text });
                }
              }
            } else if (t === 'agent.message') {
              const txt = Array.isArray(ev.content)
                ? ev.content.filter(c => c?.type === 'text' && typeof c.text === 'string').map(c => c.text).join('')
                : '';
              if (txt) {
                finalText = txt.slice(0, MAX_OUTPUT);
                if (kind === 'stream') send({ type: 'replace', text: finalText });
              }
            } else if (t === 'session.status_idle' || t === 'session.thread_status_idle') {
              terminal(finalText ?? draft); ended = true; break;
            } else if (t === 'session.status_terminated' || t === 'session.deleted') {
              terminal(finalText ?? draft); ended = true; break;
            } else if (t === 'session.status_failed' || t === 'error') {
              send({ type: 'error', code: 'ai_generation_failed', message: ERROR_MESSAGES.ai_generation_failed });
              ended = true; break;
            }
          }
          if (!ended) {
            const out = finalText ?? draft;
            if (kind === 'stream' && out && out.trim()) send({ type: 'done', state: 'partial' });
            else terminal(out);
          }
        } catch (error) {
          const { code, message } = mapError(error);
          send({ type: 'error', code, message });
        } finally {
          try { upstream?.close(); } catch { /* ignore */ }
          if (slotTaken) { releaseSlot(); slotTaken = false; }
          request.signal?.removeEventListener('abort', onAbort);
          finish();
        }
      },
      cancel() {
        lifetime.abort();
        try { upstream?.close(); } catch { /* ignore */ }
        if (slotTaken) { releaseSlot(); slotTaken = false; }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  }

  async function train(request) {
    let payload;
    try { payload = await request.json(); } catch { return jsonError('invalid_request', '请输入有效的作答内容。', 400); }
    const level = payload?.level === 'CET6' ? 'CET6' : 'CET4';
    const material = payload?.material;
    const sentences = cleanSentences(material?.sentences);
    const options = cleanOptions(material?.question?.options);
    const stem = typeof material?.question?.stem === 'string' ? material.question.stem.trim() : '';
    if (!sentences) return jsonError('invalid_material', '原文句子格式无效，请重新粘贴原文。', 400);
    if (!options) return jsonError('invalid_material', '请提供完整的 A/B/C/D 四个选项。', 400);
    if (stem.length < 5 || stem.length > 500) return jsonError('invalid_material', '请填写 5–500 字符的题干。', 400);

    const optionKeys = new Set(options.map(o => o.key));
    const chosen = typeof payload?.attempt?.choice === 'string' ? payload.attempt.choice.trim().toUpperCase() : '';
    if (!optionKeys.has(chosen)) return jsonError('invalid_attempt', '请先选择一个答案。', 400);
    const sentenceIds = new Set(sentences.map(s => s.id));
    const rawEvidence = Array.isArray(payload?.attempt?.evidence) ? payload.attempt.evidence : [];
    const evidenceIds = [...new Set(rawEvidence.filter(id => typeof id === 'string' && sentenceIds.has(id)))].slice(0, 4);
    const confidence = ['high', 'medium', 'low'].includes(payload?.attempt?.confidence) ? payload.attempt.confidence : 'medium';
    const rawRef = typeof payload?.attempt?.referenceAnswer === 'string' ? payload.attempt.referenceAnswer.trim().toUpperCase() : '';
    const referenceAnswer = optionKeys.has(rawRef) ? rawRef : '';

    const blocked = guard(request);
    if (blocked) return blocked;
    return runStream(request, {
      prompt: buildTrainUserPrompt({ level, sentences, question: stem, options, chosen, evidenceIds, confidence, referenceAnswer }),
      title: '四六级阅读错因诊断',
      kind: 'train',
      profile: TRAIN_PROFILE,
      systemPrompt: buildTrainSystemPrompt(),
      runningMessage: '正在核对你的选项与原文依据…',
      trainContext: { sentenceIds, optionKeys, chosen, confidence, referenceAnswer, evidenceIds },
    });
  }

  async function explain(request) {
    let payload;
    try { payload = await request.json(); } catch { return jsonError('invalid_request', '请输入有效的文本内容。', 400); }
    const section = typeof payload?.section === 'string' ? payload.section : '';
    if (!EXPLAIN_SECTIONS.includes(section)) return jsonError('invalid_section', '未知的解析类型。', 400);
    const level = payload?.level === 'CET6' ? 'CET6' : 'CET4';
    const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
    if (text.length < MIN_EXPLAIN) return jsonError('text_too_short', '原文太短，请粘贴至少 20 个字符的完整片段。', 400);
    if (text.length > MAX_EXPLAIN) return jsonError('text_too_long', `单次解析请控制在 ${MAX_EXPLAIN} 字符以内。`, 413);
    let part = Number(payload?.part);
    let total = Number(payload?.total);
    if (!Number.isInteger(part) || part < 1) part = 1;
    if (!Number.isInteger(total) || total < 1 || total > 50) total = 1;
    if (part > total) part = total;
    const blocked = guard(request);
    if (blocked) return blocked;
    const label = { translation: '翻译', vocab: '生词', grammar: '长难句' }[section];
    return runStream(request, {
      prompt: buildExplainUserPrompt({ section, level, text, part, total }),
      title: `四六级阅读${label}`,
      kind: 'stream',
      profile: TOOL_PROFILE,
      systemPrompt: buildToolSystemPrompt(),
      runningMessage: `正在生成${label}…`,
    });
  }

  async function transfer(request) {
    let payload;
    try { payload = await request.json(); } catch { return jsonError('invalid_request', '无效请求。', 400); }
    const errorType = typeof payload?.errorType === 'string' ? payload.errorType : '';
    const seed = Number(payload?.seed) || 0;
    const item = pickTransfer(errorType, seed);
    return json({ ok: true, source: 'engine-verified', item });
  }

  async function grade(request) {
    let payload;
    try { payload = await request.json(); } catch { return jsonError('invalid_request', '请输入有效的文本内容。', 400); }
    const level = payload?.level === 'CET6' ? 'CET6' : 'CET4';
    const writing = typeof payload?.writing === 'string' ? payload.writing.trim() : '';
    const translation = typeof payload?.translation === 'string' ? payload.translation.trim() : '';
    const writingPrompt = typeof payload?.writingPrompt === 'string' ? payload.writingPrompt.trim() : '';
    const translationSource = typeof payload?.translationSource === 'string' ? payload.translationSource.trim() : '';
    if (writing.length < MIN_ESSAY && translation.length < MIN_ESSAY) {
      return jsonError('text_too_short', '请至少粘贴一项完整的作文或翻译文本（不少于 10 个字符）。', 400);
    }
    if (writing.length > MAX_ESSAY || translation.length > MAX_ESSAY) {
      return jsonError('text_too_long', `单项文本请控制在 ${MAX_ESSAY} 字符以内。`, 413);
    }
    if (writingPrompt.length > MAX_PROMPT_MATERIAL || translationSource.length > MAX_PROMPT_MATERIAL) {
      return jsonError('text_too_long', `题目或中文原文请控制在 ${MAX_PROMPT_MATERIAL} 字符以内。`, 413);
    }
    const blocked = guard(request);
    if (blocked) return blocked;
    return runStream(request, {
      prompt: buildGradePrompt({ level, writing, writingPrompt, translation, translationSource }),
      title: '四六级写译评分',
      kind: 'grade',
      profile: ESTIMATOR_PROFILE,
      systemPrompt: buildEstimatorSystemPrompt(),
      runningMessage: '正在评分…',
      gradeContext: {
        writingMaterial: Boolean(writingPrompt),
        translationMaterial: Boolean(translationSource),
      },
    });
  }

  async function recommend(request) {
    let payload;
    try { payload = await request.json(); } catch { return jsonError('invalid_request', '无效的估分数据。', 400); }
    const level = payload?.level === 'CET6' ? 'CET6' : 'CET4';
    const estimate = payload?.estimate;
    if (!validEstimate(estimate)) return jsonError('invalid_estimate', '估分数据无效，请先完成估分。', 400);
    const blocked = guard(request);
    if (blocked) return blocked;
    const chunks = retrieve(level, estimate.weak, 8);
    const context = formatContext(chunks);
    return runStream(request, {
      prompt: buildRecommendPrompt(level, estimate, context, chunks),
      title: '四六级备考推荐',
      kind: 'stream',
      profile: ESTIMATOR_PROFILE,
      systemPrompt: buildEstimatorSystemPrompt(),
      runningMessage: '正在生成备考建议…',
    });
  }

  return async function handler(request) {
    let url;
    try { url = new URL(request.url); } catch { return jsonError('invalid_request', '无效请求。', 400); }
    const action = url.searchParams.get('action');

    if (request.method === 'GET' && action === 'health') {
      return json({ ok: true, mode, service: 'cet-studyhack-lab' });
    }
    if (action === 'train') {
      return request.method === 'POST' ? train(request) : jsonError('method_not_allowed', '请使用 POST 提交作答。', 405);
    }
    if (action === 'explain') {
      return request.method === 'POST' ? explain(request) : jsonError('method_not_allowed', '请使用 POST 提交解析。', 405);
    }
    if (action === 'transfer') {
      return request.method === 'POST' ? transfer(request) : jsonError('method_not_allowed', '请使用 POST 获取同类题。', 405);
    }
    if (action === 'grade') {
      return request.method === 'POST' ? grade(request) : jsonError('method_not_allowed', '请使用 POST 提交评分。', 405);
    }
    if (action === 'recommend') {
      return request.method === 'POST' ? recommend(request) : jsonError('method_not_allowed', '请使用 POST 获取推荐。', 405);
    }
    return jsonError('not_found', '未知的请求。', 404);
  };
}
