// DEV ONLY — exercises the REAL handler for the new short actions:
// train (evidence diagnosis JSON), explain (translation/vocab/grammar),
// transfer (vetted bank), grade with/without materials, recommend without a
// pass probability. Uses the credential-free fake cloud.
import assert from 'node:assert/strict';
import { createAppHandler } from '../functions/handler.mjs';
import { __resetResourceCache } from '../functions/resources.mjs';
import { consumeSSE } from '../functions/sse.mjs';
import { computeEstimate } from '../web/engine.js';
import { createFakeCloud } from './fake-cloud.mjs';

__resetResourceCache();
const handler = createAppHandler({ cloud: createFakeCloud({ delayMs: 1 }), mode: 'local-fixture' });

// Each request gets its own forwarded IP so the per-IP rate limiter (12 AI
// calls / 10 min) does not reject the test suite itself.
let ipSeq = 0;
const post = (action, payload) => handler(new Request(`http://local/functions/v1/app?action=${action}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-forwarded-for': `10.0.0.${++ipSeq}` },
  body: JSON.stringify(payload),
}));

async function collect(response) {
  const frames = [];
  await consumeSSE(response, f => {
    const env = JSON.parse(f.data);
    frames.push(env);
    return env.type === 'done' || env.type === 'error';
  });
  return frames;
}

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
const attempt = { choice: 'A', evidence: ['s2', 's99'], confidence: 'medium' };
const trainPayload = extra => ({
  level: 'CET4',
  material,
  attempt: { ...attempt, ...extra },
});

const passage = 'In an age of laptops and tablets, many students have abandoned handwriting in favor of typing their notes. Yet research suggests this convenience comes at a hidden cost to learning.'.repeat(2);
const essay = 'With the development of technology, online learning has become increasingly popular among college students. It offers flexibility and abundant resources, though self-discipline remains essential.'.repeat(2);
const estimate = computeEstimate({
  level: 'CET4',
  listening: { news: 4, longConv: 5, passages: 6 },
  reading: { banked: 5, matching: 6, careful: 6 },
  writing: { mode: 'band', band: 'mid' },
  translation: { mode: 'band', band: 'mid' },
});

let passed = 0;
const ok = name => { passed++; console.log(`  ok  ${name}`); };

// 1. health
{
  const res = await handler(new Request('http://local/functions/v1/app?action=health'));
  const j = await res.json();
  assert.equal(res.status, 200);
  assert.equal(j.ok, true);
  assert.equal(j.service, 'cet-studyhack-lab');
  assert.equal(j.mode, 'local-fixture');
  ok('health returns ok + lab service');
}

// 2. train happy path: JSON diagnosis, invented id filtered, no raw JSON deltas
{
  const res = await post('train', trainPayload());
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const frames = await collect(res);
  const result = frames.find(f => f.type === 'result');
  assert.ok(result, 'train result frame present');
  assert.equal(result.correct_option, 'B');
  assert.equal(result.answer_correct, false);
  assert.equal(result.error_type, 'scope_expansion');
  assert.deepEqual(result.student_evidence_ids, ['s2']);
  assert.deepEqual(result.correct_evidence_ids, ['s1']);
  assert.deepEqual(result.english_diff, { left: 'Some', right: 'all' });
  assert.ok(result.hint && !/[ABCD]/.test(result.hint), 'hint does not leak an option letter');
  assert.equal(result.alignment, 'misaligned');
  assert.ok(frames.some(f => f.type === 'done' && f.state === 'completed'));
  assert.ok(!frames.some(f => f.type === 'delta'), 'train does not leak raw JSON deltas');
  ok('train returns validated diagnosis + filters invented sentence ids');
}

// 3. answer correct but evidence misaligned -> right_answer_wrong_evidence
{
  const frames = await collect(await post('train', trainPayload({ choice: 'B', evidence: ['s2'], confidence: 'high' })));
  const result = frames.find(f => f.type === 'result');
  assert.equal(result.answer_correct, true);
  assert.equal(result.error_type, 'right_answer_wrong_evidence');
  assert.equal(result.alignment, 'misaligned');
  ok('train flags correct answer with wrong evidence');
}

// 4. answer correct + evidence aligned + high confidence -> none
{
  const frames = await collect(await post('train', trainPayload({ choice: 'B', evidence: ['s1'], confidence: 'high' })));
  const result = frames.find(f => f.type === 'result');
  assert.equal(result.answer_correct, true);
  assert.equal(result.error_type, 'none');
  assert.equal(result.alignment, 'aligned');
  ok('train accepts aligned correct answer');
}

// 5. answer correct + aligned but low confidence -> right_answer_uncertain
{
  const frames = await collect(await post('train', trainPayload({ choice: 'B', evidence: ['s1'], confidence: 'low' })));
  const result = frames.find(f => f.type === 'result');
  assert.equal(result.error_type, 'right_answer_uncertain');
  ok('train flags low-confidence correct answer');
}

// 6. user reference answer overrides the model's correct option
{
  const frames = await collect(await post('train', trainPayload({ choice: 'A', evidence: ['s1'], confidence: 'medium', referenceAnswer: 'C' })));
  const result = frames.find(f => f.type === 'result');
  assert.equal(result.correct_option, 'C');
  assert.equal(result.answer_correct, false);
  ok('train honours the user-provided reference answer');
}

// 7. train validation
{
  assert.equal((await post('train', { level: 'CET4', material: { sentences: material.sentences, question: { stem: 'x', options: [] } }, attempt })).status, 400);
  assert.equal((await post('train', { level: 'CET4', material, attempt: { choice: 'Z', evidence: ['s1'], confidence: 'high' } })).status, 400);
  const shortIds = { ...material, sentences: [{ id: 'bad id', text: 'x' }] };
  assert.equal((await post('train', { level: 'CET4', material: shortIds, attempt })).status, 400);
  assert.equal((await handler(new Request('http://local/functions/v1/app?action=train'))).status, 405);
  ok('train rejects malformed material / choice / GET');
}

// 8. explain translation streams short markdown
{
  const res = await post('explain', { section: 'translation', text: passage, level: 'CET4', part: 1, total: 2 });
  assert.equal(res.status, 200);
  const frames = await collect(res);
  const text = frames.filter(f => f.type === 'delta').map(f => f.text).join('');
  assert.ok(text.length > 20, 'translation streams text');
  assert.ok(frames.some(f => f.type === 'done' && f.state === 'completed'));
  assert.ok(!/<!--/.test(text), 'translation has no hidden block');
  ok('explain streams translation chunk');
}

// 9. explain vocab + grammar
{
  const vFrames = await collect(await post('explain', { section: 'vocab', text: passage, level: 'CET4' }));
  const vText = vFrames.filter(f => f.type === 'delta').map(f => f.text).join('');
  assert.ok(/单词/.test(vText) && /<!--VOCAB/.test(vText), 'vocab carries table + hidden VOCAB');
  const gFrames = await collect(await post('explain', { section: 'grammar', text: passage, level: 'CET4' }));
  const gText = gFrames.filter(f => f.type === 'delta').map(f => f.text).join('');
  assert.ok(/原句/.test(gText), 'grammar returns sentence breakdown');
  ok('explain returns vocab + grammar sections independently');
}

// 10. explain validation
{
  assert.equal((await post('explain', { section: 'nope', text: passage })).status, 400);
  assert.equal((await post('explain', { section: 'translation', text: 'hi' })).status, 400);
  assert.equal((await handler(new Request('http://local/functions/v1/app?action=explain'))).status, 405);
  ok('explain rejects unknown section / short text / GET');
}

// 11. transfer returns a vetted same-type item
{
  const res = await post('transfer', { errorType: 'scope_expansion', seed: 1 });
  const j = await res.json();
  assert.equal(res.status, 200);
  assert.equal(j.ok, true);
  assert.equal(j.source, 'engine-verified');
  assert.equal(j.item.errorType, 'scope_expansion');
  assert.equal(j.item.question.options.length, 4);
  const ids = new Set(j.item.passage.map(s => s.id));
  assert.ok(j.item.evidence.every(id => ids.has(id)), 'transfer evidence ids exist');
  assert.ok(['A', 'B', 'C', 'D'].includes(j.item.question.answer));
  assert.equal((await handler(new Request('http://local/functions/v1/app?action=transfer'))).status, 405);
  ok('transfer returns a vetted same-type question');
}

// 12. grade with materials -> relevance checked
{
  const res = await post('grade', {
    level: 'CET4', writing: essay, writingPrompt: 'Should college students use AI tools?',
    translation: essay, translationSource: '越来越多的大学生开始在学习中使用人工智能工具。',
  });
  const frames = await collect(res);
  const result = frames.find(f => f.type === 'result');
  assert.ok(result, 'grade result present');
  assert.equal(result.writing.relevance, 'checked');
  assert.equal(result.writing.materialMissing, false);
  assert.equal(result.translation.relevance, 'checked');
  assert.equal(result.translation.materialMissing, false);
  assert.ok(frames.some(f => f.type === 'done' && f.state === 'completed'));
  assert.ok(!frames.some(f => f.type === 'delta'), 'grade does not leak raw JSON deltas');
  ok('grade judges relevance only when materials are present');
}

// 13. grade without materials -> language-only feedback
{
  const frames = await collect(await post('grade', { level: 'CET4', writing: essay, translation: essay }));
  const result = frames.find(f => f.type === 'result');
  assert.equal(result.writing.relevance, 'not_checked');
  assert.equal(result.writing.materialMissing, true);
  assert.equal(result.translation.relevance, 'not_checked');
  assert.equal(result.translation.materialMissing, true);
  ok('grade downgrades to language feedback when materials are missing');
}

// 14. grade validation
{
  assert.equal((await post('grade', { level: 'CET4', writing: 'hi', translation: '' })).status, 400);
  assert.equal((await handler(new Request('http://local/functions/v1/app?action=grade'))).status, 405);
  ok('grade rejects too-short text / GET');
}

// 15. recommend uses reference interval, never a pass probability
{
  const res = await post('recommend', { level: 'CET4', estimate });
  const frames = await collect(res);
  const text = frames.filter(f => f.type === 'delta').map(f => f.text).join('');
  assert.ok(text.length > 50, 'recommend streams text');
  assert.ok(/参考区间/.test(text), 'recommend mentions reference interval');
  assert.ok(!/通过概率|通过率/.test(text), 'recommend does not mention pass probability');
  assert.ok(frames.some(f => f.type === 'done'));
  ok('recommend is grounded and avoids pass probability');
}

// 16. recommend validation
{
  assert.equal((await post('recommend', { level: 'CET4', estimate: { total: 400 } })).status, 400);
  ok('recommend rejects invalid estimate');
}

// 17. failure then retry (fake cloud fails once for FAILTEST)
{
  const failingText = ('This passage is used to trigger a local failure once. '.repeat(3)) + 'FAILTEST';
  const first = await collect(await post('explain', { section: 'translation', text: failingText, level: 'CET4' }));
  const err = first.find(f => f.type === 'error');
  assert.ok(err, 'first attempt errors');
  assert.equal(err.code, 'ai_generation_failed');
  assert.ok(!first.some(f => f.type === 'done'));
  const second = await collect(await post('explain', { section: 'translation', text: failingText, level: 'CET4' }));
  assert.ok(second.some(f => f.type === 'done' && f.state === 'completed'), 'retry succeeds');
  assert.ok(second.some(f => f.type === 'delta'), 'retry streams content');
  ok('failure surfaces an error and the same request can be retried');
}

// 18. model invents the correct evidence -> refuse to diagnose
{
  const noEvidenceMaterial = {
    ...material,
    sentences: [
      material.sentences[0],
      material.sentences[1],
      { id: 's3', text: 'NOEVIDENCE marker for this local fixture.' },
    ],
  };
  const frames = await collect(await post('train', {
    level: 'CET4', material: noEvidenceMaterial,
    attempt: { choice: 'A', evidence: ['s2'], confidence: 'medium' },
  }));
  const result = frames.find(f => f.type === 'result');
  assert.equal(result.error_type, 'evidence_insufficient');
  assert.deepEqual(result.correct_evidence_ids, []);
  ok('train refuses to diagnose without a real evidence sentence');
}

// 19. unknown action
{
  const res = await handler(new Request('http://local/functions/v1/app?action=nope'));
  assert.equal(res.status, 404);
  ok('unknown action -> 404');
}

console.log(`\n${passed} handler checks passed.`);
