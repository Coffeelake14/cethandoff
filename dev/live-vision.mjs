// DEV ONLY — real Qoder Cloud Agents acceptance probe.
//
// It calls the documented Cloud Agents API directly (not through the Site
// gateway) so the team can answer with real data:
//   1. Which models does this account actually see?
//   2. Does a candidate model accept an image block, and what are the real
//      latency / credits / recognition result?
//   3. Does a real grade reply invent quotes, deduct wrongly or lack a basis?
//
// Auth (never printed, never written to the repo):
//   PowerShell (stores it in the Windows User environment, not shell history):
//     $secure = Read-Host "Qoder PAT" -AsSecureString
//     $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
//     $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
//     [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
//     [Environment]::SetEnvironmentVariable("QODER_ACCESS_TOKEN", $plain, "User")
//     Remove-Variable secure, bstr, plain
//     node .\dev\live-vision.mjs --list-models
//   Git Bash:
//     export QODER_ACCESS_TOKEN="..."
//     node dev/live-vision.mjs --list-models
//
// QODER_PAT is accepted as an alias. When neither process variable is set on
// Windows, the script reads the User-scope variable in a child PowerShell, so
// the token never appears in a command line. QODER_API_BASE_URL /
// QODER_API_ORIGIN may include /api/v1/cloud; it is normalised to the origin.
//
// Results (full transcript, parsed JSON, audit) are written to
// dev/live-results/ (gitignored) and never contain the token or the image.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  buildStructuredScanSystemPrompt,
  buildStructuredScanUserPrompt,
  buildEstimatorSystemPrompt,
  buildGradePrompt,
  SCAN_PROMPT_VERSION,
} from '../functions/prompt.mjs';
import { readSSE } from '../functions/sse.mjs';

/* ---------------- args ---------------- */

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const body = token.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) { out[body.slice(0, eq)] = body.slice(eq + 1); continue; }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { out[body] = next; i += 1; } else out[body] = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const flag = name => args[name] === true || args[name] === 'true';
const value = name => (typeof args[name] === 'string' ? args[name] : '');

const TOKEN = await resolveToken();
const RAW_ORIGIN = value('origin') || process.env.QODER_API_BASE_URL || process.env.QODER_API_ORIGIN
  || 'https://api.qoder.com.cn';
const ORIGIN = RAW_ORIGIN.replace(/\/+$/, '').replace(/\/api\/v1\/cloud$/i, '');
const IMAGE = value('image');
const TARGET = ['reading', 'writing', 'translation'].includes(value('target')) ? value('target') : 'writing';
const LEVEL = value('level') === 'CET6' ? 'CET6' : 'CET4';
const MODEL_ARG = value('model');
const ALL_MODELS = flag('all-models');
const MAX_MODELS = Math.max(1, Number(value('max-models') || 3));
const LIST_ONLY = flag('list-models') || flag('models-only');
const GRADE_AFTER_SCAN = flag('grade-after-scan');
const GRADE_ONLY = flag('grade') && !GRADE_AFTER_SCAN;
const FULL = flag('full');
const OUT_DIR = resolve(value('out') || 'dev/live-results');
const TIMEOUT_MS = Math.max(30000, Number(value('timeout') || 180000));

if (!TOKEN) {
  console.error('缺少 QODER_ACCESS_TOKEN（或 QODER_PAT）。请在当前终端设置个人 PAT，脚本不会打印它。');
  console.error('PowerShell 安全输入并写入 User 环境变量（不会进入命令历史）：');
  console.error('  $secure = Read-Host "Qoder PAT" -AsSecureString');
  console.error('  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)');
  console.error('  $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)');
  console.error('  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)');
  console.error('  [Environment]::SetEnvironmentVariable("QODER_ACCESS_TOKEN", $plain, "User")');
  console.error('  Remove-Variable secure, bstr, plain');
  console.error('  node .\\dev\\live-vision.mjs --list-models');
  process.exit(2);
}

const redact = text => String(text || '').split(TOKEN).join('<redacted>');

// If the launching shell has no token, fall back to the Windows *User*
// environment variable so the PAT can be set once without being pasted into a
// command line. The captured value is held in memory only and never logged.
async function resolveToken() {
  const direct = process.env.QODER_ACCESS_TOKEN || process.env.QODER_PAT || '';
  if (direct || process.platform !== 'win32') return direct;
  for (const name of ['QODER_ACCESS_TOKEN', 'QODER_PAT']) {
    try {
      const { stdout } = await promisify(execFile)(
        'powershell.exe',
        ['-NoProfile', '-Command', `[Environment]::GetEnvironmentVariable('${name}','User')`],
        { windowsHide: true, timeout: 10000 },
      );
      const token = stdout.replace(/^\uFEFF/, '').trim();
      if (token) return token;
    } catch { /* no User env var */ }
  }
  return '';
}

/* ---------------- files ---------------- */

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif',
};

async function readText(pathOrEmpty) {
  if (!pathOrEmpty) return '';
  return (await readFile(pathOrEmpty, 'utf8')).trim();
}

async function loadImage() {
  if (!IMAGE) return null;
  const mime = MIME[extname(IMAGE).toLowerCase()];
  if (!mime) throw new Error('仅支持 JPG / PNG / WebP / GIF 图片。');
  const raw = await readFile(IMAGE);
  if (raw.length > 10 * 1024 * 1024) {
    throw new Error(`图片 ${raw.length} 字节，超过单张 Base64 10 MiB 的限制。`);
  }
  const base64 = raw.toString('base64');
  if (Buffer.byteLength(base64, 'utf8') > 10 * 1024 * 1024) {
    throw new Error('Base64 编码后超过 10 MiB，请先压缩图片。');
  }
  return { raw, mime, base64 };
}

/* ---------------- api ---------------- */

const headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${ORIGIN}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual',
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) {
    const detail = json?.error?.message || text.slice(0, 300);
    const error = new Error(redact(`${method} ${path} -> ${res.status} ${detail}`));
    error.status = res.status;
    throw error;
  }
  return json;
}

function shortHash(text) {
  return createHash('sha1').update(text).digest('hex').slice(0, 8);
}

function agentName(kind, model, system) {
  const base = `cet-live-${kind}-${model}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 48);
  return `${base}-${shortHash(system)}`.slice(0, 64);
}

async function ensureEnvironment() {
  const name = 'cet-live-vision-probe';
  const envs = await api('/api/v1/cloud/environments?limit=100');
  const existing = (envs?.data || []).find(e => e.name === name && !e.archived_at);
  if (existing) return existing;
  return api('/api/v1/cloud/environments', {
    method: 'POST', body: { name, config: { type: 'cloud' }, metadata: { purpose: 'cet-live-probe' } },
  });
}

async function ensureAgent({ model, kind, system }) {
  const name = agentName(kind, model, system);
  const agents = await api('/api/v1/cloud/agents?limit=100');
  const existing = (agents?.data || []).find(a => a.name === name && !a.archived_at);
  if (existing) return { id: existing.id, version: existing.version, reused: true };
  const created = await api('/api/v1/cloud/agents', {
    method: 'POST',
    body: {
      name, model, system, tools: [],
      metadata: { purpose: 'cet-live-probe', kind, prompt: shortHash(system) },
    },
  });
  return { id: created.id, version: created.version, reused: false };
}

/* ---------------- one model turn ---------------- */

async function runTurn({ model, environmentId, kind, system, content, title }) {
  const agent = await ensureAgent({ model, kind, system });
  const session = await api('/api/v1/cloud/sessions', {
    method: 'POST',
    body: {
      agent: { id: agent.id, type: 'agent', version: agent.version },
      environment_id: environmentId,
      title,
      metadata: { purpose: 'cet-live-probe', kind, model },
    },
  });
  if (!/^sess_/.test(session?.id || '')) throw new Error('创建 Session 未返回 sess_ id');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = Date.now();
  let stream;
  try {
    stream = await fetch(`${ORIGIN}/api/v1/cloud/sessions/${session.id}/events/stream`, {
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'text/event-stream' },
      redirect: 'manual',
      signal: controller.signal,
    });
    if (!stream.ok || !stream.body) {
      throw new Error(redact(`SSE 连接失败：HTTP ${stream.status} ${(await stream.text()).slice(0, 300)}`));
    }
    const postedAt = Date.now();
    await api(`/api/v1/cloud/sessions/${session.id}/events`, {
      method: 'POST',
      body: { events: [{ type: 'user.message', content }] },
    });

    let finalText = '';
    let draft = '';
    let firstDeltaMs = null;
    let ended = false;
    let timedOut = false;
    let sessionError = '';
    const usage = {
      requestCredits: [], requestCreditsTotal: 0,
      modelCredits: null, sandboxCredits: null, totalCredits: null,
    };
    try {
      for await (const frame of readSSE(stream.body, { maxFrameChars: 262144 })) {
        let ev;
        try { ev = JSON.parse(frame.data); } catch { continue; }
        if (ev.type === 'event_delta' && ev.delta?.type === 'content_delta' && typeof ev.delta.content?.text === 'string') {
          if (firstDeltaMs === null) firstDeltaMs = Date.now() - postedAt;
          draft += ev.delta.content.text;
        } else if (ev.type === 'agent.message') {
          finalText = Array.isArray(ev.content)
            ? ev.content.filter(c => c?.type === 'text').map(c => c.text).join('')
            : '';
        } else if (ev.type === 'span.model_request_end') {
          if (Number.isFinite(Number(ev.model_usage?.credits))) {
            const credits = Number(ev.model_usage.credits);
            usage.requestCredits.push(credits);
            usage.requestCreditsTotal += credits;
          }
        } else if (ev.type === 'session.usage') {
          usage.modelCredits = Number.isFinite(Number(ev.model_credits)) ? Number(ev.model_credits) : null;
          usage.sandboxCredits = Number.isFinite(Number(ev.sandbox_runtime_credits)) ? Number(ev.sandbox_runtime_credits) : null;
          usage.totalCredits = Number.isFinite(Number(ev.total_credits)) ? Number(ev.total_credits) : null;
        } else if (ev.type === 'session.error') {
          if (ev.error?.retry_status?.type !== 'retrying') {
            sessionError = redact(`${ev.error?.type || 'error'}: ${ev.error?.message || ''}`);
          }
        } else if (ev.type === 'session.status_idle' || ev.type === 'session.status_terminated') {
          ended = true;
          break;
        }
      }
    } catch (error) {
      if (controller.signal.aborted) timedOut = true;
      else throw error;
    }
    return {
      agentId: agent.id,
      agentReused: agent.reused,
      sessionId: session.id,
      text: finalText || draft,
      firstDeltaMs,
      seconds: Number(((Date.now() - postedAt) / 1000).toFixed(1)),
      ended: ended && !timedOut,
      timedOut,
      sessionError,
      usage,
    };
  } finally {
    clearTimeout(timer);
    try { controller.abort(); } catch { /* already closed */ }
    try { await api(`/api/v1/cloud/sessions/${session.id}/archive`, { method: 'POST' }); } catch { /* best-effort */ }
  }
}

/* ---------------- parsing + audits ---------------- */

function extractJson(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const raw = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const from = raw.indexOf('{');
  const to = raw.lastIndexOf('}');
  if (from < 0 || to <= from) return null;
  try { return JSON.parse(raw.slice(from, to + 1)); } catch { return null; }
}

function squash(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function locateQuote(text, quote) {
  if (!text || !quote) return false;
  if (text.includes(quote)) return true;
  if (text.toLowerCase().includes(quote.toLowerCase())) return true;
  return squash(text).includes(squash(quote));
}

const WRITING_TYPES = new Set(['spelling', 'grammar', 'word_choice', 'collocation', 'structure', 'coherence', 'punctuation', 'content']);
const TRANSLATION_TYPES = new Set(['omission', 'misread', 'grammar', 'word_choice', 'expression', 'punctuation', 'content']);

function auditStructuredScan(obj, { target }) {
  const issues = [];
  const warnings = [];
  if (!obj) return { pass: false, issues: ['模型没有返回可解析的 JSON'], warnings, stats: {} };
  const text = typeof obj.text === 'string' ? obj.text.trim() : '';
  if (!text) issues.push('text 为空');
  if (obj.kind !== target) warnings.push(`kind=${obj.kind ?? '缺失'}，期望 ${target}`);
  const fields = [text, obj.passage, obj.prompt_material, obj.student_answer]
    .filter(v => typeof v === 'string' && v);
  if (target === 'reading') {
    if (!(typeof obj.passage === 'string' && obj.passage.trim())) issues.push('passage 为空');
    if (!Array.isArray(obj.questions) || !obj.questions.length) warnings.push('questions 为空（可能只拍了文章页）');
    for (const [i, q] of (Array.isArray(obj.questions) ? obj.questions : []).entries()) {
      const options = Array.isArray(q?.options) ? q.options : [];
      const keys = options.map(o => String(o?.key || '').toUpperCase());
      if (!q?.no || !q?.stem) issues.push(`第 ${i + 1} 题缺少题号或题干`);
      if (options.length !== 4 || new Set(keys).size !== 4 || !keys.every(k => 'ABCD'.includes(k))) {
        issues.push(`第 ${i + 1} 题选项不是完整 A/B/C/D`);
      }
      if (options.some(o => !String(o?.text || '').trim())) issues.push(`第 ${i + 1} 题有空选项`);
    }
  } else {
    if (!(typeof obj.student_answer === 'string' && obj.student_answer.trim())) issues.push('student_answer 为空');
    if (target === 'translation' && !(typeof obj.prompt_material === 'string' && obj.prompt_material.trim())) {
      warnings.push('prompt_material 为空（没有识别到中文原题）');
    }
  }
  const uncertain = Array.isArray(obj.uncertain) ? obj.uncertain : [];
  if (uncertain.length > 20) issues.push(`uncertain 超过 20 项（${uncertain.length}）`);
  const source = fields.join('\n');
  const badUncertain = uncertain.filter(x => typeof x !== 'string' || x.length < 2 || !source.includes(x));
  if (badUncertain.length) issues.push(`${badUncertain.length} 个 uncertain 不是正文真实子串`);
  if (!['high', 'medium', 'low'].includes(obj.confidence)) warnings.push('confidence 缺失或非法');
  if (typeof obj.notes === 'string' && obj.notes.length > 200) warnings.push('notes 过长');
  return {
    pass: issues.length === 0,
    issues,
    warnings,
    stats: {
      kind: obj.kind ?? null,
      textChars: text.length,
      passageChars: typeof obj.passage === 'string' ? obj.passage.length : 0,
      questions: Array.isArray(obj.questions) ? obj.questions.length : 0,
      promptChars: typeof obj.prompt_material === 'string' ? obj.prompt_material.length : 0,
      answerChars: typeof obj.student_answer === 'string' ? obj.student_answer.length : 0,
      uncertain: uncertain.length,
      confidence: obj.confidence ?? null,
      notes: obj.notes ?? null,
    },
  };
}

function bandOf(score) {
  return score <= 7 ? 'low' : score <= 10 ? 'mid' : 'high';
}

function auditModule(raw, { label, text, hasMaterial, isWriting }) {
  const issues = [];
  const warnings = [];
  const allow = isWriting ? WRITING_TYPES : TRANSLATION_TYPES;
  const item = raw && typeof raw === 'object' ? raw : null;
  if (!item) return { issues: [`${label} 缺失`], warnings, stats: {} };
  let score = Number(item.score);
  if (!Number.isFinite(score)) score = null;
  else score = Math.round(Math.min(15, Math.max(0, score)) * 10) / 10;
  if (text && score === null) issues.push(`${label} 有学生文本却没有分数`);
  if (!text && score !== null) issues.push(`${label} 没有学生文本却给了分数`);
  if (score !== null) {
    if (score < 0 || score > 15) issues.push(`${label} 分数越界 ${score}`);
    if (!['low', 'mid', 'high'].includes(item.band)) warnings.push(`${label} band 缺失或非法`);
    else if (item.band !== bandOf(score)) issues.push(`${label} band=${item.band} 与分数 ${score} 不匹配`);
    const expectedRelevance = hasMaterial ? 'checked' : 'not_checked';
    if (item.relevance !== expectedRelevance) {
      issues.push(`${label} relevance=${item.relevance ?? '缺失'}，期望 ${expectedRelevance}`);
    }
  }
  if (typeof item.comment !== 'string' || !item.comment.trim()) warnings.push(`${label} comment 为空`);

  const errors = Array.isArray(item.errors) ? item.errors : [];
  if (errors.length > 12) issues.push(`${label} errors 超过 12 条（${errors.length}）`);
  let located = 0;
  for (const [i, err] of errors.entries()) {
    const quote = typeof err?.quote === 'string' ? err.quote.trim() : '';
    const type = typeof err?.type === 'string' ? err.type.trim().toLowerCase() : '';
    if (!quote || quote.length < 2 || quote.length > 60) {
      issues.push(`${label} 第 ${i + 1} 条 quote 长度非法`);
      continue;
    }
    if (!allow.has(type)) issues.push(`${label} 第 ${i + 1} 条错误类型非法：${type || '空'}`);
    if (!hasMaterial && (type === 'content' || (!isWriting && (type === 'omission' || type === 'misread')))) {
      issues.push(`${label} 第 ${i + 1} 条在缺少材料时使用了 ${type}`);
    }
    if (!text || !locateQuote(text, quote)) {
      issues.push(`${label} 第 ${i + 1} 条 quote 无法在学生原文中定位：${JSON.stringify(quote)}`);
    } else located += 1;
    if (!String(err?.fix || '').trim() && !String(err?.note || '').trim()) {
      issues.push(`${label} 第 ${i + 1} 条缺少 fix 与 note`);
    }
  }
  const suggestions = Array.isArray(item.suggestions) ? item.suggestions : [];
  if (suggestions.length > 3) issues.push(`${label} suggestions 超过 3 条（${suggestions.length}）`);
  if (suggestions.some(s => typeof s !== 'string' || s.trim().length < 4)) warnings.push(`${label} 有无效建议`);
  return {
    issues,
    warnings,
    stats: {
      score,
      band: item.band ?? null,
      relevance: item.relevance ?? null,
      errors: errors.length,
      quotesLocated: located,
      suggestions: suggestions.length,
    },
  };
}

function auditGrade(obj, ctx) {
  if (!obj) return { pass: false, issues: ['模型没有返回可解析的 JSON'], warnings: [], stats: {} };
  const writing = auditModule(obj.writing, {
    label: 'writing', text: ctx.writing, hasMaterial: Boolean(ctx.writingPrompt), isWriting: true,
  });
  const translation = auditModule(obj.translation, {
    label: 'translation', text: ctx.translation, hasMaterial: Boolean(ctx.translationSource), isWriting: false,
  });
  const issues = [...writing.issues, ...translation.issues];
  const warnings = [...writing.warnings, ...translation.warnings];
  if (writing.stats.score == null && translation.stats.score == null) issues.push('写作与翻译都没有有效分数');
  return { pass: issues.length === 0, issues, warnings, stats: { writing: writing.stats, translation: translation.stats } };
}

/* ---------------- main ---------------- */

let image = null;
try { image = await loadImage(); } catch (error) {
  console.error(redact(error.message));
  process.exit(2);
}

const startedAt = Date.now();
const models = await api('/api/v1/cloud/models');
const list = Array.isArray(models?.data) ? models.data : [];
const enabled = list.filter(m => m.is_enabled !== false);
console.log('可用模型（GET /api/v1/cloud/models；官方目录没有视觉能力字段）：');
for (const m of list) {
  console.log(`  - ${m.id} | ${m.display_name || ''} | enabled=${m.is_enabled !== false} | price_factor=${m.price_factor ?? '-'} | max_input=${m.max_input_tokens ?? '-'}`);
}
if (LIST_ONLY) process.exit(0);

const candidates = ALL_MODELS ? enabled.slice(0, MAX_MODELS) : [];
const selected = ALL_MODELS
  ? candidates
  : [MODEL_ARG || enabled[0]?.id || ''].filter(Boolean);
if (!selected.length) {
  console.error('账号没有可用模型。');
  process.exit(3);
}
if (!ALL_MODELS && MODEL_ARG && !list.some(m => m.id === MODEL_ARG)) {
  console.error(`--model ${MODEL_ARG} 不在当前账号的模型列表中。`);
  process.exit(3);
}

const writingText = await readText(value('writing-file'));
const writingPrompt = await readText(value('writing-prompt-file'));
const translationText = await readText(value('translation-file'));
const translationSource = await readText(value('translation-source-file'));

if (!image && !GRADE_ONLY) {
  console.error('缺少 --image；若只想做评分审计，请提供 --writing-file / --translation-file 并加 --grade。');
  process.exit(2);
}
if (GRADE_ONLY && !writingText && !translationText) {
  console.error('--grade 需要 --writing-file 或 --translation-file。');
  process.exit(2);
}

const environment = await ensureEnvironment();
const runs = [];

for (const model of selected) {
  const label = `${model} → ${image ? TARGET : 'grade'}`;
  console.log(`\n=== ${label} ===`);
  const run = { model, target: TARGET, level: LEVEL, imageBytes: image?.raw.length || 0 };
  try {
    let ocr = null;
    if (image) {
      const system = buildStructuredScanSystemPrompt();
      const content = [
        { type: 'text', text: buildStructuredScanUserPrompt({ target: TARGET, level: LEVEL }) },
        { type: 'image', source: { type: 'base64', media_type: image.mime, data: image.base64 } },
      ];
      ocr = await runTurn({
        model, environmentId: environment.id, kind: `scan-${TARGET}`, system, content,
        title: `CET scan probe · ${TARGET} · ${SCAN_PROMPT_VERSION}`,
      });
      ocr.parsed = extractJson(ocr.text);
      ocr.audit = auditStructuredScan(ocr.parsed, { target: TARGET });
      run.ocr = ocr;
      console.log(`OCR：${ocr.seconds}s | 首字 ${ocr.firstDeltaMs ?? '-'}ms | credits=${ocr.usage.totalCredits ?? ocr.usage.requestCreditsTotal} | JSON=${Boolean(ocr.parsed)}${ocr.sessionError ? ` | error=${ocr.sessionError}` : ''}`);
      console.log(`审计：${ocr.audit.pass ? 'PASS' : 'FAIL'}${ocr.audit.issues.length ? ` — ${ocr.audit.issues.join('；')}` : ''}`);
      if (!ocr.parsed) console.log(`原始回复：\n${redact(ocr.text.slice(0, 1500))}`);
    }

    const shouldGrade = GRADE_ONLY || GRADE_AFTER_SCAN;
    if (shouldGrade) {
      let w = writingText;
      let wp = writingPrompt;
      let t = translationText;
      let ts = translationSource;
      if (GRADE_AFTER_SCAN && ocr?.parsed) {
        if (TARGET === 'writing') {
          w = typeof ocr.parsed.student_answer === 'string' ? ocr.parsed.student_answer : '';
          wp = typeof ocr.parsed.prompt_material === 'string' ? ocr.parsed.prompt_material : '';
        } else if (TARGET === 'translation') {
          t = typeof ocr.parsed.student_answer === 'string' ? ocr.parsed.student_answer : '';
          ts = typeof ocr.parsed.prompt_material === 'string' ? ocr.parsed.prompt_material : '';
        } else {
          console.log('评分：跳过（reading 没有写作/翻译文本）。');
        }
      }
      if (w.trim() || t.trim()) {
        const system = buildEstimatorSystemPrompt();
        const prompt = buildGradePrompt({ level: LEVEL, writing: w, writingPrompt: wp, translation: t, translationSource: ts });
        const grade = await runTurn({
          model, environmentId: environment.id, kind: 'grade', system,
          content: [{ type: 'text', text: prompt }],
          title: `CET grade probe · ${LEVEL}`,
        });
        grade.parsed = extractJson(grade.text);
        grade.audit = auditGrade(grade.parsed, {
          writing: w, writingPrompt: wp, translation: t, translationSource: ts,
        });
        run.grade = grade;
        console.log(`评分：${grade.seconds}s | credits=${grade.usage.totalCredits ?? grade.usage.requestCreditsTotal} | JSON=${Boolean(grade.parsed)}${grade.sessionError ? ` | error=${grade.sessionError}` : ''}`);
        console.log(`审计：${grade.audit.pass ? 'PASS' : 'FAIL'}${grade.audit.issues.length ? ` — ${grade.audit.issues.join('；')}` : ''}`);
        if (!grade.parsed) console.log(`原始回复：\n${redact(grade.text.slice(0, 1500))}`);
      } else {
        console.log('评分：没有可用的写作/翻译文本，跳过。');
      }
    }
  } catch (error) {
    run.error = redact(error.message);
    console.error(`失败：${run.error}`);
  }

  const ocrPass = !image || (run.ocr?.parsed && run.ocr?.audit?.pass && !run.ocr?.sessionError);
  const gradePass = !run.grade || (run.grade.parsed && run.grade.audit?.pass && !run.grade?.sessionError);
  run.pass = Boolean(ocrPass && gradePass && !run.error && !run.ocr?.timedOut && !run.grade?.timedOut);
  runs.push(run);

  if (run.ocr) {
    const preview = run.ocr.parsed
      ? (FULL ? run.ocr.text : run.ocr.text.slice(0, 4000))
      : run.ocr.text.slice(0, 4000);
    console.log(`\n识别结果${FULL ? '' : '（前 4000 字，完整内容见结果文件）'}：\n${redact(preview)}`);
  }
  if (run.grade) {
    const preview = run.grade.parsed
      ? (FULL ? run.grade.text : run.grade.text.slice(0, 4000))
      : run.grade.text.slice(0, 4000);
    console.log(`\n评分结果${FULL ? '' : '（前 4000 字，完整内容见结果文件）'}：\n${redact(preview)}`);
  }
}

await mkdir(OUT_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outFile = resolve(OUT_DIR, `live-${stamp}.json`);
const report = {
  generatedAt: new Date().toISOString(),
  origin: ORIGIN,
  promptVersion: SCAN_PROMPT_VERSION,
  image: IMAGE ? { file: IMAGE, bytes: image.raw.length, mime: image.mime } : null,
  level: LEVEL,
  models: list.map(m => ({
    id: m.id, displayName: m.display_name || null, enabled: m.is_enabled !== false,
    priceFactor: m.price_factor ?? null, maxInputTokens: m.max_input_tokens ?? null,
    defaultContextWindow: m.default_context_window ?? null,
  })),
  elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
  runs,
};
await writeFile(outFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

console.log('\n=== SUMMARY ===');
console.log(`模型 | 类型 | OCR 秒 | OCR credits | 评分 credits | 结论`);
for (const run of runs) {
  const seconds = run.ocr?.seconds ?? run.grade?.seconds ?? '-';
  const ocrCredits = run.ocr?.usage?.totalCredits ?? run.ocr?.usage?.requestCreditsTotal ?? '-';
  const gradeCredits = run.grade?.usage?.totalCredits ?? run.grade?.usage?.requestCreditsTotal ?? '-';
  console.log(`${run.model} | ${image ? TARGET : GRADE_ONLY ? 'grade' : 'scan+grade'} | ${seconds} | ${ocrCredits} | ${gradeCredits} | ${run.pass ? 'PASS' : 'FAIL'}`);
}
console.log(`\n结果文件：${outFile}`);
const allPass = runs.length > 0 && runs.every(run => run.pass);
console.log(allPass
  ? '\nLIVE VISION PROBE: PASS'
  : '\nLIVE VISION PROBE: FAIL — 真实模型/识别/评分仍有问题，详见上面的审计与结果文件。');
process.exit(allPass ? 0 : 1);