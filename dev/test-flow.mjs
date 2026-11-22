// DEV ONLY — end-to-end flow through the local fixture server (real handler,
// fake cloud). Covers the new short-request actions and the failure/retry path.
import { consumeSSE } from '../web/sse.mjs';
import { computeEstimate } from '../web/engine.js';

const BASE = 'http://127.0.0.1:4318';
const app = `${BASE}/functions/v1/app`;

let ipSeq = 0;
async function post(action, payload) {
  return fetch(`${app}?action=${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': `10.9.0.${++ipSeq}` },
    body: JSON.stringify(payload),
  });
}

async function collect(res) {
  const frames = [];
  await consumeSSE(res, frame => {
    const env = JSON.parse(frame.data);
    frames.push(env);
    return env.type === 'done' || env.type === 'error';
  });
  return frames;
}

const results = [];
const check = (name, cond) => { results.push({ name, ok: !!cond }); console.log(`${cond ? '  ok ' : '  FAIL'} ${name}`); };

const health = await fetch(`${app}?action=health`).then(r => r.json());
console.log('health:', JSON.stringify(health));
check('health ok', health.ok && health.service === 'cet-studyhack-lab');

const passage = 'Many students now read their course materials on screens rather than on paper. Some of the students who used tablets reported feeling more distracted by notifications. For quick scanning, a screen is clearly more convenient.';

// translation chunk
{
  const res = await post('explain', { section: 'translation', text: passage, level: 'CET4', part: 1, total: 1 });
  const frames = await collect(res);
  const text = frames.filter(f => f.type === 'delta').map(f => f.text).join('');
  const done = frames.find(f => f.type === 'done');
  console.log('translation delta chars:', text.length, 'done:', done?.state);
  check('translation streams + completes', text.length > 20 && done?.state === 'completed');
  check('translation has no hidden block', !text.includes('<!--'));
}

// vocab
{
  const frames = await collect(await post('explain', { section: 'vocab', text: passage, level: 'CET4' }));
  const text = frames.filter(f => f.type === 'delta').map(f => f.text).join('');
  check('vocab returns table + VOCAB block', /单词/.test(text) && text.includes('<!--VOCAB'));
}

// grammar
{
  const frames = await collect(await post('explain', { section: 'grammar', text: passage, level: 'CET4' }));
  const text = frames.filter(f => f.type === 'delta').map(f => f.text).join('');
  check('grammar returns breakdown', /原句/.test(text));
}

// train (custom material)
const material = {
  sentences: [
    { id: 's1', text: 'Some students read on screens every day.' },
    { id: 's2', text: 'All screens cause eye strain, according to the claim.' },
    { id: 's3', text: 'Reading habits vary from person to person.' },
  ],
  question: {
    stem: 'What can we learn about screen reading?',
    options: [
      { key: 'A', text: 'All screens cause eye strain.' },
      { key: 'B', text: 'Some students read on screens.' },
      { key: 'C', text: 'Habits never vary.' },
      { key: 'D', text: 'Nobody reads on paper.' },
    ],
  },
};
let trainResult = null;
{
  const frames = await collect(await post('train', {
    level: 'CET4', material,
    attempt: { choice: 'A', evidence: ['s2', 's99'], confidence: 'medium' },
  }));
  trainResult = frames.find(f => f.type === 'result');
  const done = frames.find(f => f.type === 'done');
  console.log('train result:', JSON.stringify(trainResult));
  check('train returns result + done', !!trainResult && done?.state === 'completed');
  check('train filters invented evidence id', trainResult && !trainResult.student_evidence_ids.includes('s99'));
  check('train reports scope expansion', trainResult?.error_type === 'scope_expansion');
}

// transfer
{
  const res = await post('transfer', { errorType: trainResult?.error_type || 'scope_expansion', seed: 2 });
  const j = await res.json();
  console.log('transfer item:', j?.item?.id, j?.item?.errorType);
  check('transfer returns vetted same-type item', j?.ok && j.item.errorType === 'scope_expansion');
}

// grade with + without materials
{
  const essay = 'With the development of technology, online learning has become increasingly popular among college students. It offers flexibility and abundant resources, though self-discipline remains essential.'.repeat(2);
  const withMat = await collect(await post('grade', {
    level: 'CET4', writing: essay, writingPrompt: 'Should students use AI tools?', translation: essay, translationSource: '越来越多的大学生使用人工智能工具。',
  }));
  const r1 = withMat.find(f => f.type === 'result');
  check('grade with materials checks relevance', r1?.writing.relevance === 'checked' && r1?.translation.relevance === 'checked');

  const noMat = await collect(await post('grade', { level: 'CET4', writing: essay, translation: essay }));
  const r2 = noMat.find(f => f.type === 'result');
  check('grade without materials is language-only', r2?.writing.relevance === 'not_checked' && r2?.writing.materialMissing === true);
}

// recommend (no pass probability)
{
  const estimate = computeEstimate({
    level: 'CET4',
    listening: { news: 4, longConv: 5, passages: 6 },
    reading: { banked: 5, matching: 6, careful: 6 },
    writing: { mode: 'band', band: 'mid' },
    translation: { mode: 'band', band: 'mid' },
  });
  const frames = await collect(await post('recommend', { level: 'CET4', estimate }));
  const text = frames.filter(f => f.type === 'delta').map(f => f.text).join('');
  check('recommend streams grounded text', text.length > 50 && /参考区间/.test(text));
  check('recommend has no pass probability', !/通过概率|通过率/.test(text));
}

// failure -> retry through the server
{
  const failingText = ('A local failure is injected once for this request. '.repeat(3)) + `FAILTEST-${Date.now()}`;
  const first = await collect(await post('explain', { section: 'translation', text: failingText, level: 'CET4' }));
  const err = first.find(f => f.type === 'error');
  const second = await collect(await post('explain', { section: 'translation', text: failingText, level: 'CET4' }));
  check('first attempt fails cleanly', err?.code === 'ai_generation_failed');
  check('retry succeeds', second.some(f => f.type === 'done' && f.state === 'completed'));
}

// validation
{
  const short = await post('explain', { section: 'translation', text: 'hi' });
  console.log('short input ->', short.status, (await short.json()).error);
  check('short input rejected', short.status === 400);
  const wrongMethod = await fetch(`${app}?action=explain`);
  check('GET explain rejected', wrongMethod.status === 405);
  const unknown = await fetch(`${app}?action=bogus`);
  check('unknown action 404', unknown.status === 404);
}

const failed = results.filter(r => !r.ok);
console.log(failed.length === 0 ? 'FLOW PASS' : `FLOW FAIL (${failed.length})`);
process.exit(failed.length === 0 ? 0 : 1);
