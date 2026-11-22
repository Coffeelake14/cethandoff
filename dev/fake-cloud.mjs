// DEV ONLY — credential-free fake Cloud upstream. Tracks the last posted user
// message so openStream can return the matching canned reply for the new short
// actions: train (JSON), explain (translation/vocab/grammar), grade, recommend.
// A prompt containing FAILTEST fails once, then succeeds, so the local site can
// demonstrate the failure -> retry path. Never deployed.
import {
  FIXTURE_TRAIN, FIXTURE_TRAIN_NO_EVIDENCE, FIXTURE_TRANSLATION, FIXTURE_VOCAB, FIXTURE_GRAMMAR,
  fixtureGrade, FIXTURE_RECOMMEND,
} from './fixture.mjs';

const delay = ms => new Promise(r => setTimeout(r, ms));
const frame = (type, obj, id = 'evt_fixture') => `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(obj)}\n\n`;

export function replyFor(prompt) {
  if (/【学生选项】/.test(prompt)) return prompt.includes('NOEVIDENCE') ? FIXTURE_TRAIN_NO_EVIDENCE : FIXTURE_TRAIN;
  if (/【作文题目】/.test(prompt) && /"relevance"/.test(prompt)) return fixtureGrade(prompt);
  if (/【内置资料】/.test(prompt)) return FIXTURE_RECOMMEND;
  if (/表头固定为：\| 单词/.test(prompt)) return FIXTURE_VOCAB;
  if (/\*\*原句：\*\*/.test(prompt) && /长难句/.test(prompt)) return FIXTURE_GRAMMAR;
  if (/只输出中文译文/.test(prompt)) return FIXTURE_TRANSLATION;
  return '（本地示例未匹配到请求类型，请检查 prompt 标记）';
}

function framesFor(text) {
  const frames = [];
  frames.push(frame('session.status_running', { type: 'session.status_running' }));
  frames.push(frame('event_start', { type: 'event_start', event: { id: 'evt_msg', type: 'agent.message' } }, 'evt_msg'));
  for (const c of text.match(/[\s\S]{1,7}/g) || []) {
    frames.push(frame('event_delta', { type: 'event_delta', event_id: 'evt_msg', delta: { type: 'content_delta', index: 0, content: { type: 'text', text: c } } }, 'evt_msg'));
  }
  frames.push(frame('agent.message', { type: 'agent.message', id: 'evt_msg', content: [{ type: 'text', text }] }, 'evt_msg'));
  frames.push(frame('session.status_idle', { type: 'session.status_idle' }));
  return frames;
}

function failureFrames() {
  return [
    frame('session.status_running', { type: 'session.status_running' }),
    frame('session.status_failed', { type: 'session.status_failed' }),
  ];
}

export function createFakeCloud({ delayMs = 12 } = {}) {
  let counter = 0;
  let lastPrompt = '';
  const failedOnce = new Set();
  return {
    async request(path, { method = 'GET', body } = {}) {
      if (path === '/api/v1/cloud/models') return { data: [{ id: 'fixture-model', enabled: true }], has_more: false };
      if (method === 'POST' && path === '/api/v1/cloud/environments') return { id: `env_fixture${++counter}` };
      if (method === 'POST' && path === '/api/v1/cloud/agents') return { id: `agent_fixture${++counter}`, version: 1 };
      if (method === 'POST' && path === '/api/v1/cloud/sessions') return { id: `sess_fixture${++counter}` };
      if (method === 'POST' && /\/events$/.test(path)) {
        lastPrompt = body?.events?.[0]?.content?.[0]?.text || '';
        return { id: 'evt_user' };
      }
      return { data: [], has_more: false };
    },
    async findResources() { return []; },
    openStream(_sessionId, { signal } = {}) {
      const encoder = new TextEncoder();
      let frames = null;
      let idx = 0;
      let cancelled = false;
      const onAbort = () => { cancelled = true; };
      signal?.addEventListener('abort', onAbort, { once: true });
      // Resolve the reply on first read (pull), after the handler has posted the
      // user message — openStream itself runs before that POST.
      const body = new ReadableStream({
        async pull(controller) {
          if (frames === null) {
            const prompt = lastPrompt;
            if (prompt.includes('FAILTEST') && !failedOnce.has(prompt)) {
              failedOnce.add(prompt);
              frames = failureFrames();
            } else {
              frames = framesFor(replyFor(prompt));
            }
          }
          if (cancelled || idx >= frames.length) { try { controller.close(); } catch { /* closed */ } return; }
          const f = frames[idx++];
          controller.enqueue(encoder.encode(f));
          await delay(f.includes('event_delta') ? delayMs : 40);
        },
        cancel() { cancelled = true; },
      }, { highWaterMark: 0 });
      return { body, close() { cancelled = true; signal?.removeEventListener('abort', onAbort); } };
    },
  };
}
