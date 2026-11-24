// DEV ONLY — real Qoder Cloud Agents vision probe.
//
// This does NOT go through the deployed Site (the gateway rejects non-browser
// origins). It calls the documented Cloud Agents API directly with a PAT so the
// team can answer two questions with real data:
//   1. Which models does this account actually see?
//   2. Does the selected model genuinely accept an image content block, and
//      what are the real latency / credits / recognition result?
//
// Usage:
//   QODER_PAT=... node dev/live-vision.mjs --image dev/fixtures/page.jpg --target reading
//   QODER_PAT=... node dev/live-vision.mjs --image essay.png --target writing --model <model-id>
//
// CN API origin defaults to https://api.qoder.com.cn (see Qoder CN quickstart).
// Never commit a PAT. The script never prints the token.
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { buildStructuredScanSystemPrompt, buildStructuredScanUserPrompt } from '../functions/prompt.mjs';
import { readSSE } from '../functions/sse.mjs';

const args = process.argv.slice(2);
const argOf = name => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : '';
};
const PAT = process.env.QODER_PAT || '';
const ORIGIN = (argOf('origin') || process.env.QODER_API_ORIGIN || 'https://api.qoder.com.cn').replace(/\/+$/, '');
const IMAGE = argOf('image');
const TARGET = ['reading', 'writing', 'translation'].includes(argOf('target')) ? argOf('target') : 'reading';
const MODEL_ARG = argOf('model');

if (!PAT) {
  console.error('缺少 QODER_PAT。请使用个人访问令牌运行，例如：');
  console.error('  QODER_PAT=... node dev/live-vision.mjs --image page.jpg --target reading');
  process.exit(2);
}
if (!IMAGE) {
  console.error('缺少 --image。请提供一张真实试卷/作文照片。');
  process.exit(2);
}

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif',
};
const mime = MIME[extname(IMAGE).toLowerCase()];
if (!mime) {
  console.error('仅支持 JPG / PNG / WebP / GIF 图片。');
  process.exit(2);
}

const raw = await readFile(IMAGE);
if (raw.length > 10 * 1024 * 1024) {
  console.error(`图片 ${raw.length} 字节，超过单张 Base64 10 MiB 的限制。`);
  process.exit(2);
}
const base64 = raw.toString('base64');
if (Buffer.byteLength(base64, 'utf8') > 10 * 1024 * 1024) {
  console.error('Base64 编码后超过 10 MiB，请先压缩图片。');
  process.exit(2);
}

const headers = { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' };
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${ORIGIN}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual',
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) {
    const detail = json?.error?.message || text.slice(0, 300);
    const error = new Error(`${method} ${path} -> ${res.status} ${detail}`);
    error.status = res.status;
    throw error;
  }
  return json;
}

const started = Date.now();
const models = await api('/api/v1/cloud/models');
const list = Array.isArray(models?.data) ? models.data : [];
console.log('可用模型（GET /api/v1/cloud/models，文档未提供视觉能力字段）：');
for (const m of list) {
  console.log(`  - ${m.id} | ${m.display_name || ''} | enabled=${m.is_enabled !== false} | price_factor=${m.price_factor ?? '-'} | max_input=${m.max_input_tokens ?? '-'}`);
}
const model = MODEL_ARG || list.find(m => m.is_enabled !== false)?.id;
if (!model) {
  console.error('账号没有可用模型。');
  process.exit(3);
}
if (MODEL_ARG && !list.some(m => m.id === MODEL_ARG)) {
  console.error(`--model ${MODEL_ARG} 不在当前账号的模型列表中。请从上面的 id 中选择。`);
  process.exit(3);
}
console.log(`\n本次使用模型：${model}`);

const envName = 'cet-live-vision-probe';
const envs = await api('/api/v1/cloud/environments?limit=100');
let environment = (envs?.data || []).find(e => e.name === envName && !e.archived_at);
if (!environment) {
  environment = await api('/api/v1/cloud/environments', {
    method: 'POST', body: { name: envName, config: { type: 'cloud' }, metadata: { purpose: 'cet-live-probe' } },
  });
  console.log(`已创建探针 Environment：${environment.id}`);
} else {
  console.log(`复用探针 Environment：${environment.id}`);
}

const agentName = `cet-live-vision-${model}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 64);
const agents = await api('/api/v1/cloud/agents?limit=100');
let agent = (agents?.data || []).find(a => a.name === agentName && !a.archived_at);
if (!agent) {
  agent = await api('/api/v1/cloud/agents', {
    method: 'POST',
    body: {
      name: agentName,
      model,
      system: buildStructuredScanSystemPrompt(),
      tools: [],
      metadata: { purpose: 'cet-live-probe' },
    },
  });
  console.log(`已创建探针 Agent：${agent.id} (v${agent.version})`);
} else {
  console.log(`复用探针 Agent：${agent.id} (v${agent.version}, model=${agent.model})`);
}

const session = await api('/api/v1/cloud/sessions', {
  method: 'POST',
  body: {
    agent: { id: agent.id, type: 'agent', version: agent.version },
    environment_id: environment.id,
    title: `CET vision probe · ${TARGET}`,
    metadata: { purpose: 'cet-live-probe', target: TARGET },
  },
});
if (!/^sess_/.test(session?.id || '')) throw new Error('创建 Session 未返回 sess_ id');
console.log(`Session：${session.id}`);

const stream = await fetch(`${ORIGIN}/api/v1/cloud/sessions/${session.id}/events/stream`, {
  headers: { Authorization: `Bearer ${PAT}`, Accept: 'text/event-stream' },
  redirect: 'manual',
  signal: AbortSignal.timeout(150000),
});
if (!stream.ok || !stream.body) {
  console.error(`SSE 连接失败：HTTP ${stream.status} ${(await stream.text()).slice(0, 300)}`);
  process.exit(3);
}

await api(`/api/v1/cloud/sessions/${session.id}/events`, {
  method: 'POST',
  body: {
    events: [{
      type: 'user.message',
      content: [
        { type: 'text', text: buildStructuredScanUserPrompt({ target: TARGET, level: 'CET4' }) },
        { type: 'image', source: { type: 'base64', media_type: mime, data: base64 } },
      ],
    }],
  },
});

let finalText = '';
let draft = '';
const usage = { modelCredits: null, sandboxCredits: null, totalCredits: null, requestCredits: null };
let sessionError = '';
let ended = false;
for await (const frame of readSSE(stream.body, { maxFrameChars: 262144 })) {
  let ev;
  try { ev = JSON.parse(frame.data); } catch { continue; }
  if (ev.type === 'event_delta' && ev.delta?.type === 'content_delta' && typeof ev.delta.content?.text === 'string') {
    draft += ev.delta.content.text;
  } else if (ev.type === 'agent.message') {
    finalText = Array.isArray(ev.content)
      ? ev.content.filter(c => c?.type === 'text').map(c => c.text).join('')
      : '';
  } else if (ev.type === 'span.model_request_end') {
    if (Number.isFinite(Number(ev.model_usage?.credits))) usage.requestCredits = Number(ev.model_usage.credits);
  } else if (ev.type === 'session.usage') {
    usage.modelCredits = Number.isFinite(Number(ev.model_credits)) ? Number(ev.model_credits) : null;
    usage.sandboxCredits = Number.isFinite(Number(ev.sandbox_runtime_credits)) ? Number(ev.sandbox_runtime_credits) : null;
    usage.totalCredits = Number.isFinite(Number(ev.total_credits)) ? Number(ev.total_credits) : null;
  } else if (ev.type === 'session.error') {
    if (ev.error?.retry_status?.type !== 'retrying') {
      sessionError = `${ev.error?.type || 'error'}: ${ev.error?.message || ''}`;
    }
  } else if (ev.type === 'session.status_idle' || ev.type === 'session.status_terminated') {
    ended = true;
    break;
  }
}

const text = finalText || draft;
const seconds = ((Date.now() - started) / 1000).toFixed(1);
let parsed = null;
try {
  const rawJson = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  parsed = JSON.parse(rawJson.slice(rawJson.indexOf('{'), rawJson.lastIndexOf('}') + 1));
} catch { /* not JSON */ }

console.log('\n=== RESULT ===');
console.log(JSON.stringify({
  origin: ORIGIN,
  model,
  target: TARGET,
  imageBytes: raw.length,
  seconds: Number(seconds),
  ended,
  sessionError: sessionError || null,
  usage,
  jsonValid: Boolean(parsed),
  kind: parsed?.kind ?? null,
  textChars: typeof parsed?.text === 'string' ? parsed.text.length : text.length,
  passageChars: typeof parsed?.passage === 'string' ? parsed.passage.length : null,
  questions: Array.isArray(parsed?.questions) ? parsed.questions.length : null,
  promptChars: typeof parsed?.prompt_material === 'string' ? parsed.prompt_material.length : null,
  answerChars: typeof parsed?.student_answer === 'string' ? parsed.student_answer.length : null,
  uncertain: Array.isArray(parsed?.uncertain) ? parsed.uncertain.length : null,
  confidence: parsed?.confidence ?? null,
  notes: parsed?.notes ?? null,
}, null, 2));
if (!parsed) {
  console.log('\n原始回复（前 1200 字）：\n' + text.slice(0, 1200));
}
console.log(parsed && !sessionError
  ? '\nLIVE VISION PROBE: PASS'
  : '\nLIVE VISION PROBE: FAIL — 该模型/账号未能完成结构化识图，详见上方的 sessionError 与原始回复。');

try {
  await api(`/api/v1/cloud/sessions/${session.id}/archive`, { method: 'POST' });
} catch { /* archiving is best-effort */ }
process.exit(parsed && !sessionError ? 0 : 1);
