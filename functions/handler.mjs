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
//   scan     -> strict JSON transcription of a handwritten answer photo
//   grade    -> short strict JSON writing/translation feedback (with materials)
//   recommend-> RAG retrieval over the built-in corpus, streamed grounded notes
//
// Web-standard Request/Response/ReadableStream so the same handler runs on the
// deployed Deno edge runtime and on a local Node fixture runner.

import { readSSE } from './sse.mjs';
import {
  buildToolSystemPrompt, buildExplainUserPrompt,
  buildTrainSystemPrompt, buildTrainUserPrompt,
  buildScanSystemPrompt, buildScanUserPrompt,
  buildStructuredScanSystemPrompt, buildStructuredScanUserPrompt,
  buildEstimatorSystemPrompt, buildGradePrompt, buildRecommendPrompt,
  SCAN_PROMPT_VERSION,
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
const MAX_IMAGE_BASE64 = 6000000;
const MAX_IMAGE_BYTES = 4000000;
const MAX_SCAN_READING = 12000;
const MAX_SCAN_QUESTIONS = 20;
const MAX_SCAN_OPTION_CHARS = 300;
const MAX_SCAN_UNCERTAIN = 20;
const MAX_GRADE_ERRORS = 12;
const SCAN_CACHE_TTL_MS = 10 * 60 * 1000;
const SCAN_CACHE_MAX = 32;
const SCAN_CACHE_VERSION = 1;
const MAX_OUTPUT = 200000;
const MAX_STREAM_MS = 120000;
const MAX_CONCURRENT = 4;
const RATE_WINDOW_MS = 600000;
const RATE_MAX = 12;
const MODULE_KEYS = ['listening', 'reading', 'writing', 'translation'];
const EXPLAIN_SECTIONS = ['translation', 'vocab', 'grammar'];
const WRITING_ERROR_TYPES = new Set(['spelling', 'grammar', 'word_choice', 'collocation', 'structure', 'coherence', 'punctuation', 'content']);
const TRANSLATION_ERROR_TYPES = new Set(['omission', 'misread', 'grammar', 'word_choice', 'expression', 'punctuation', 'content']);
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
  // v2: grade output now includes sentence-level errors and suggestions, which
  // live in the Agent's system prompt. A new scope (re)creates the Agent once.
  scope: 'cet-score-estimator:v2:prod:cn',
  envName: 'CET Score Environment',
  agentName: '四六级估分备考助手',
  metadata: { app: 'cet-score-estimator' },
  purpose: 'estimation',
};
const SCAN_PROFILE = {
  envName: 'CET Writing Scan Environment',
  agentName: '四六级写译拍照识别',
  metadata: { app: 'cet-writing-scan' },
  purpose: 'handwriting-transcription',
  vision: true,
  modelEnv: 'CET_SCAN_MODEL',
};

// Structured and plain scans use different system prompts. They must not share
// one cached Agent, otherwise whichever mode boots first fixes the prompt for
// the other mode. The prompt version also makes a prompt edit self-invalidating.
function scanProfile(structured) {
  const mode = structured ? 'structured' : 'text';
  return {
    ...SCAN_PROFILE,
    scope: `cet-writing-scan:${mode}:${SCAN_PROMPT_VERSION}:prod:cn`,
    agentName: `${SCAN_PROFILE.agentName}-${mode}`,
  };
}

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
  ai_scan_invalid: '识别结果无法解析，请重拍或手动输入。',
  ai_scan_empty: '没有识别到清晰文字，请正对纸张重拍。',
  ai_vision_unsupported: '当前 AI 模型未启用图片输入，请改用手动粘贴文本，或联系站点管理员配置支持图片的模型。',
  ai_quota_exceeded: 'AI 额度已用尽，请稍后再试或检查账号额度。',
  ai_request_too_large: '上传内容过大，请选择更小的图片。',
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

// Upstream session errors are free text; only classify them to pick a stable
// user-facing message. The raw message never reaches the browser.
function classifySessionFailure(message, kind) {
  const text = String(message || '');
  if (/quota|credits?|balance|insufficient|exceeded.*(limit|budget)|budget|额度|余额|配额/i.test(text)) {
    return { code: 'ai_quota_exceeded', message: ERROR_MESSAGES.ai_quota_exceeded };
  }
  if (kind === 'scan' && /image|vision|multimodal|modality|unsupported|not support|图片|视觉|多模态|不支持/i.test(text)) {
    return { code: 'ai_vision_unsupported', message: ERROR_MESSAGES.ai_vision_unsupported };
  }
  return { code: 'ai_generation_failed', message: ERROR_MESSAGES.ai_generation_failed };
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
  const norm = (item, hasMaterial, studentText, isWriting) => {
    if (!item || typeof item !== 'object') {
      return {
        score: null, band: null, relevance: 'not_checked', materialMissing: false,
        comment: '未提供有效文本', errors: [], stats: {}, suggestions: [], errorCount: 0,
      };
    }
    let score = Number(item.score);
    if (!Number.isFinite(score)) score = null;
    else score = Math.round(Math.min(15, Math.max(0, score)) * 10) / 10;
    let band = ['low', 'mid', 'high'].includes(item.band) ? item.band : null;
    if (score === null) band = null;
    else if (!band) band = bandOf(score);
    const relevance = score !== null && hasMaterial ? 'checked' : 'not_checked';
    const comment = typeof item.comment === 'string' ? item.comment.slice(0, 400) : '';
    const details = score === null
      ? { errors: [], stats: {}, suggestions: [], errorCount: 0 }
      : cleanGradeDetails(item, { text: studentText, isWriting, hasMaterial });
    return { score, band, relevance, materialMissing: score !== null && !hasMaterial, comment, ...details };
  };
  const writing = norm(obj.writing, Boolean(ctx.writingMaterial), ctx.writingText || '', true);
  const translation = norm(obj.translation, Boolean(ctx.translationMaterial), ctx.translationText || '', false);
  if (writing.score === null && translation.score === null) return null;
  return { writing, translation };
}

// Parse the model's strict-JSON transcription. Only the visible text is kept;
// the browser fills the grader textarea with it so the student can correct OCR
// mistakes before scoring.
function parseScan(text, maxChars = MAX_ESSAY) {
  const obj = extractJson(text);
  if (!obj || typeof obj.text !== 'string') return null;
  const cleaned = obj.text.replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim().slice(0, maxChars);
  const confidence = ['high', 'medium', 'low'].includes(obj.confidence) ? obj.confidence : 'medium';
  const notes = typeof obj.notes === 'string' ? obj.notes.trim().slice(0, 200) : '';
  return { text: cleaned, confidence, notes };
}

function cleanScanText(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim().slice(0, max);
}

// Reading questions are only kept when the model returned a complete, ordered
// A/B/C/D set; invalid entries are dropped rather than repaired or invented.
function cleanScanQuestions(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const raw of input.slice(0, MAX_SCAN_QUESTIONS)) {
    if (!raw || typeof raw !== 'object') continue;
    const no = typeof raw.no === 'string' || typeof raw.no === 'number'
      ? String(raw.no).replace(/\s+/g, '').slice(0, 12) : '';
    const stem = cleanScanText(raw.stem, 500);
    if (!no || stem.length < 5) continue;
    if (!Array.isArray(raw.options) || raw.options.length !== 4) continue;
    const keys = new Set();
    const options = [];
    for (const opt of raw.options) {
      const key = typeof opt?.key === 'string' ? opt.key.trim().toUpperCase() : '';
      const text = cleanScanText(opt?.text, MAX_SCAN_OPTION_CHARS);
      if (!['A', 'B', 'C', 'D'].includes(key) || keys.has(key) || !text) { options.length = 0; break; }
      keys.add(key);
      options.push({ key, text });
    }
    if (options.length !== 4) continue;
    out.push({ no, stem, options });
  }
  return out;
}

function cleanUncertain(input, haystack) {
  if (!Array.isArray(input) || !haystack) return [];
  const seen = new Set();
  const out = [];
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const item = raw.trim();
    if (item.length < 2 || item.length > 80 || seen.has(item) || !haystack.includes(item)) continue;
    seen.add(item);
    out.push(item);
    if (out.length >= MAX_SCAN_UNCERTAIN) break;
  }
  return out;
}

// Structured OCR. Only fields applicable to the requested target are retained,
// so a writing photo can never silently produce reading questions (or vice
// versa), and every uncertain marker must be a real substring of the transcript.
function parseStructuredScan(text, target, maxChars = MAX_ESSAY) {
  const obj = extractJson(text);
  if (!obj) return null;
  const full = cleanScanText(obj.text, maxChars);
  if (!full) return null;
  const allowedKinds = ['reading', 'writing', 'translation', 'other'];
  const kind = allowedKinds.includes(obj.kind) ? obj.kind : 'other';
  const passage = target === 'reading' ? cleanScanText(obj.passage, maxChars) : '';
  const promptMaterial = target === 'writing' || target === 'translation'
    ? cleanScanText(obj.prompt_material, MAX_PROMPT_MATERIAL) : '';
  const studentAnswer = target === 'writing' || target === 'translation'
    ? cleanScanText(obj.student_answer, maxChars) : '';
  const questions = target === 'reading' ? cleanScanQuestions(obj.questions) : [];
  const uncertain = cleanUncertain(obj.uncertain, [full, passage, promptMaterial, studentAnswer].join('\n'));
  const confidence = ['high', 'medium', 'low'].includes(obj.confidence) ? obj.confidence : 'medium';
  const notes = cleanScanText(obj.notes, 200);
  return {
    kind,
    text: full,
    passage,
    questions,
    prompt_material: promptMaterial,
    student_answer: studentAnswer,
    uncertain,
    confidence,
    notes,
  };
}

// Return the exact slice from the student text so the report never highlights a
// case-normalised or whitespace-normalised rewrite of the model's quote.
function locateQuote(text, quote) {
  if (!text || !quote) return null;
  const exact = text.indexOf(quote);
  if (exact >= 0) return text.slice(exact, exact + quote.length);
  const loose = text.toLowerCase().indexOf(quote.toLowerCase());
  if (loose >= 0) return text.slice(loose, loose + quote.length);
  const squash = value => value.replace(/\s+/g, ' ').trim();
  if (squash(text).toLowerCase().includes(squash(quote).toLowerCase())) return quote;
  return null;
}

// Sentence-level feedback is validated against the student's text: quotes that
// the model cannot point to are dropped, and error types are restricted by
// module and by whether the matching material (prompt / Chinese source) exists.
function cleanGradeDetails(item, { text, isWriting, hasMaterial }) {
  const allow = isWriting ? WRITING_ERROR_TYPES : TRANSLATION_ERROR_TYPES;
  const errors = [];
  const seen = new Set();
  if (Array.isArray(item?.errors) && text) {
    for (const raw of item.errors) {
      if (!raw || typeof raw !== 'object') continue;
      const rawQuote = cleanScanText(raw.quote, 60);
      const type = typeof raw.type === 'string' ? raw.type.trim().toLowerCase() : '';
      if (rawQuote.length < 2 || !allow.has(type)) continue;
      if (!hasMaterial && (type === 'content' || (!isWriting && (type === 'omission' || type === 'misread')))) continue;
      const quote = locateQuote(text, rawQuote);
      if (!quote) continue;
      const dedupe = `${type}:${quote}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      const fix = cleanScanText(raw.fix, 200);
      const note = cleanScanText(raw.note, 160);
      if (!fix && !note) continue;
      errors.push({ quote, type, fix, note });
      if (errors.length >= MAX_GRADE_ERRORS) break;
    }
  }
  const stats = {};
  for (const error of errors) stats[error.type] = (stats[error.type] || 0) + 1;
  const suggestions = Array.isArray(item?.suggestions)
    ? [...new Set(item.suggestions.map(s => cleanScanText(s, 120)).filter(s => s.length >= 4))].slice(0, 3)
    : [];
  return { errors, stats, suggestions, errorCount: errors.length };
}

// Validate a browser-compressed answer photo. Base64 may be a data URL or raw
// base64 plus mediaType; the magic bytes must match the declared format so the
// endpoint cannot be used to smuggle arbitrary payloads into a model request.
function cleanImage(image, mediaType) {
  if (typeof image !== 'string' || !image.trim()) return null;
  let mime = typeof mediaType === 'string' ? mediaType.trim().toLowerCase() : '';
  let data = image.trim();
  const dataUrl = /^data:(image\/(?:jpeg|png|webp));base64,([\s\S]+)$/i.exec(data);
  if (dataUrl) {
    mime = dataUrl[1].toLowerCase();
    data = dataUrl[2];
  }
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)) return null;
  data = data.replace(/\s+/g, '');
  if (data.length < 64 || data.length > MAX_IMAGE_BASE64) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return null;
  const padded = data + '='.repeat((4 - (data.length % 4)) % 4);
  let bytes;
  try { bytes = Uint8Array.from(atob(padded), ch => ch.charCodeAt(0)); } catch { return null; }
  if (bytes.length < 64 || bytes.length > MAX_IMAGE_BYTES) return null;
  const jpeg = bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF;
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47
    && bytes[4] === 0x0D && bytes[5] === 0x0A && bytes[6] === 0x1A && bytes[7] === 0x0A;
  const webp = bytes.length > 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
  if ((mime === 'image/jpeg' && !jpeg) || (mime === 'image/png' && !png) || (mime === 'image/webp' && !webp)) return null;
  return { mediaType: mime, base64: data, bytes };
}

// Cache entries are scoped to an anonymous browser session. Without a valid
// scope the request still runs, but it neither reads nor writes the shared
// in-memory cache, so one visitor can never receive another visitor's result.
function cleanScanScope(value) {
  if (typeof value !== 'string') return '';
  const scope = value.trim();
  return /^[A-Za-z0-9_-]{8,64}$/.test(scope) ? scope : '';
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
  // Process-local, short-lived cache of recognised text keyed by a SHA-256 of
  // the uploaded bytes + an anonymous browser scope + target + mode + resolved
  // model + prompt version. Photos are never stored; only the validated JSON
  // result is kept, and only to avoid a duplicate credit spend.
  const scanCache = new Map();

  function scanCacheGet(key) {
    const hit = scanCache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > SCAN_CACHE_TTL_MS) { scanCache.delete(key); return null; }
    return hit.value;
  }
  function scanCacheSet(key, value) {
    const now = Date.now();
    for (const [k, v] of scanCache) if (now - v.at > SCAN_CACHE_TTL_MS) scanCache.delete(k);
    scanCache.set(key, { at: now, value });
    if (scanCache.size > SCAN_CACHE_MAX) scanCache.delete(scanCache.keys().next().value);
  }
  async function imageDigest(bytes) {
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
  }
  function cachedStream(result, binding) {
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        const send = obj => controller.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(obj)}\n\n`));
        send({ type: 'status', state: 'running', message: '已找到同一张照片的识别结果，直接复用…' });
        send({
          type: 'result', ...result, cached: true, usage: null,
          meta: {
            model: typeof binding?.model === 'string' ? binding.model : null,
            visionDeclared: binding?.visionDeclared === true,
            modelSource: binding?.modelSource || null,
            promptVersion: SCAN_PROMPT_VERSION,
            durationMs: 0,
            cached: true,
          },
        });
        send({ type: 'done', state: 'completed' });
        controller.close();
      },
    });
    return new Response(body, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  }

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
  //   kind 'scan'   -> collect text, parse strict JSON transcription, emit result
  function runStream(request, {
    prompt, title, kind, profile, systemPrompt, runningMessage, trainContext,
    gradeContext, scanContext, image, binding: initialBinding = null, promptVersion = '',
  }) {
    const encoder = new TextEncoder();
    const startedAt = performance.now();
    const lifetime = new AbortController();
    const onAbort = () => lifetime.abort();
    request.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => lifetime.abort(), MAX_STREAM_MS);
    let upstream = null;
    let slotTaken = false;
    let binding = initialBinding;
    let usage = null;
    let requestCredits = null;
    const usageOut = () => {
      if (!usage && requestCredits === null) return null;
      return {
        modelCredits: usage?.modelCredits ?? null,
        sandboxCredits: usage?.sandboxCredits ?? null,
        totalCredits: usage?.totalCredits ?? null,
        requestCredits,
      };
    };
    const resultMeta = () => ({
      model: typeof binding?.model === 'string' ? binding.model : null,
      visionDeclared: binding?.visionDeclared === true,
      modelSource: binding?.modelSource || null,
      promptVersion,
      durationMs: Math.round(performance.now() - startedAt),
    });

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
            if (parsed) {
              send({ type: 'result', ...parsed, usage: usageOut(), meta: resultMeta() });
              send({ type: 'done', state: 'completed' });
            } else send({ type: 'error', code: 'ai_grade_invalid', message: ERROR_MESSAGES.ai_grade_invalid });
          } else if (kind === 'scan') {
            const parsed = scanContext?.mode === 'structured'
              ? parseStructuredScan(out, scanContext.target, scanContext.maxChars || MAX_ESSAY)
              : parseScan(out, scanContext?.maxChars || MAX_ESSAY);
            if (!parsed) send({ type: 'error', code: 'ai_scan_invalid', message: ERROR_MESSAGES.ai_scan_invalid });
            else if (!parsed.text) send({ type: 'error', code: 'ai_scan_empty', message: ERROR_MESSAGES.ai_scan_empty });
            else {
              if (scanContext?.cacheKey) scanCacheSet(scanContext.cacheKey, parsed);
              send({ type: 'result', ...parsed, cached: false, usage: usageOut(), meta: resultMeta() });
              send({ type: 'done', state: 'completed' });
            }
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
          if (!binding) binding = await ensureResources(cloud, profile.scope, systemPrompt, profile);
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
          const content = [{ type: 'text', text: prompt }];
          if (image) {
            content.push({
              type: 'image',
              source: { type: 'base64', media_type: image.mediaType, data: image.base64 },
            });
          }
          await cloud.request(`/api/v1/cloud/sessions/${sessionId}/events`, {
            method: 'POST',
            body: { events: [{ type: 'user.message', content }] },
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
            } else if (t === 'session.usage') {
              const modelCredits = Number(ev.model_credits);
              const sandboxCredits = Number(ev.sandbox_runtime_credits);
              const totalCredits = Number(ev.total_credits);
              if ([modelCredits, sandboxCredits, totalCredits].some(Number.isFinite)) {
                usage = {
                  modelCredits: Number.isFinite(modelCredits) ? modelCredits : null,
                  sandboxCredits: Number.isFinite(sandboxCredits) ? sandboxCredits : null,
                  totalCredits: Number.isFinite(totalCredits) ? totalCredits : null,
                };
              }
            } else if (t === 'span.model_request_end') {
              const credits = Number(ev?.model_usage?.credits);
              if (Number.isFinite(credits)) requestCredits = credits;
            } else if (t === 'session.error') {
              // Rescheduling errors are retried by the platform; keep waiting.
              if (ev?.error?.retry_status?.type === 'retrying') continue;
              const message = String(ev?.error?.message || '');
              const failure = classifySessionFailure(message, kind);
              send({ type: 'error', code: failure.code, message: failure.message });
              ended = true; break;
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

  async function scan(request) {
    let payload;
    try { payload = await request.json(); } catch { return jsonError('invalid_request', '请输入有效的图片。', 400); }
    const target = ['writing', 'translation', 'reading'].includes(payload?.target) ? payload.target : '';
    if (!target) return jsonError('invalid_target', '请选择识别对象（阅读、写作或翻译）。', 400);
    const level = payload?.level === 'CET6' ? 'CET6' : 'CET4';
    if (typeof payload?.image === 'string' && payload.image.length > MAX_IMAGE_BASE64 * 1.1) {
      return jsonError('image_too_large', '图片过大，请重拍或选择更小的照片。', 413);
    }
    const image = cleanImage(payload?.image, payload?.mediaType);
    if (!image) return jsonError('invalid_image', '图片格式无效，请上传 JPG / PNG / WebP 照片。', 400);
    const structured = payload?.mode === 'structured' || payload?.structured === true;
    const maxChars = target === 'reading' ? MAX_SCAN_READING : MAX_ESSAY;
    const profile = scanProfile(structured);
    const systemPrompt = structured ? buildStructuredScanSystemPrompt() : buildScanSystemPrompt();
    const userPrompt = structured
      ? buildStructuredScanUserPrompt({ target, level })
      : buildScanUserPrompt({ target, level });

    // The model id is part of the cache key, so it must be resolved before the
    // lookup. ensureResources is process-cached and does not spend credits.
    let binding;
    try {
      binding = await ensureResources(cloud, profile.scope, systemPrompt, profile);
    } catch (error) {
      const mapped = mapError(error);
      return jsonError(mapped.code, mapped.message, 502);
    }

    const cacheScope = cleanScanScope(request.headers.get('x-cet-scan-scope'));
    const cacheKey = cacheScope
      ? [
        SCAN_CACHE_VERSION, await imageDigest(image.bytes), target, level,
        structured ? 'structured' : 'text', binding.model, SCAN_PROMPT_VERSION, cacheScope,
      ].join(':')
      : '';
    if (cacheKey && payload?.bypassCache !== true) {
      const hit = scanCacheGet(cacheKey);
      if (hit) return cachedStream(hit, binding);
    }
    const blocked = guard(request);
    if (blocked) return blocked;
    const label = target === 'reading' ? '阅读材料' : target === 'translation' ? '翻译' : '作文';
    return runStream(request, {
      prompt: userPrompt,
      title: structured ? `四六级${label}结构化拍照识别` : `四六级${label}拍照识别`,
      kind: 'scan',
      profile,
      systemPrompt,
      binding,
      promptVersion: SCAN_PROMPT_VERSION,
      runningMessage: structured ? '正在识别文字并提取题目结构…' : '正在识别文字…',
      scanContext: { mode: structured ? 'structured' : 'text', target, maxChars, cacheKey },
      image,
    });
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
        writingText: writing,
        translationText: translation,
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
    if (action === 'scan') {
      return request.method === 'POST' ? scan(request) : jsonError('method_not_allowed', '请使用 POST 上传照片。', 405);
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
