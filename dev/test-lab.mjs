// DEV ONLY — data integrity for the preset lab and vetted transfer bank.
// Guards the rule that a displayed English contrast must actually exist in the
// cited evidence sentence and in the option, and that every answer/evidence id
// is real. Run: node dev/test-lab.mjs
import { LAB_PRESETS, ERROR_LABELS } from '../web/lab-data.js';
import { pickTransfer, listTransferTypes } from '../functions/lab-bank.mjs';

let fail = 0;
const assert = (cond, msg) => { if (!cond) { fail++; console.log('ASSERT FAIL:', msg); } };
const norm = s => String(s).toLowerCase().replace(/\s+/g, ' ').trim();
const contains = (text, word) => norm(text).includes(norm(word));

function validateItem(label, item) {
  assert(Array.isArray(item.passage || item.sentences) && (item.passage || item.sentences).length >= 3, `${label}: passage has sentences`);
  const sentences = item.passage || item.sentences;
  const ids = new Set();
  for (const s of sentences) {
    assert(/^s\d+$/.test(s.id), `${label}: sentence id format (${s.id})`);
    assert(!ids.has(s.id), `${label}: unique sentence id (${s.id})`);
    assert(typeof s.text === 'string' && s.text.trim().length > 5, `${label}: sentence text (${s.id})`);
    assert(Number.isInteger(s.para) && s.para >= 1, `${label}: sentence para (${s.id})`);
    ids.add(s.id);
  }
  const q = item.question;
  assert(q && typeof q.stem === 'string' && q.stem.length > 5, `${label}: stem`);
  assert(Array.isArray(q.options) && q.options.length === 4, `${label}: four options`);
  const keys = new Set(q.options.map(o => o.key));
  assert(keys.size === 4 && ['A', 'B', 'C', 'D'].every(k => keys.has(k)), `${label}: option keys A-D`);
  assert(keys.has(q.answer), `${label}: answer is a real option`);
  assert(Array.isArray(item.evidence) && item.evidence.length, `${label}: correct evidence present`);
  assert(item.evidence.every(id => ids.has(id)), `${label}: correct evidence ids exist`);

  const answerText = q.options.find(o => o.key === q.answer).text;
  const evidenceText = item.evidence.map(id => sentences.find(s => s.id === id).text).join(' ');

  for (const opt of q.options) {
    if (opt.key === q.answer) continue;
    const trap = item.traps?.[opt.key];
    assert(trap && ERROR_LABELS[trap.type], `${label}: trap for ${opt.key}`);
    if (!trap) continue;
    assert(typeof trap.hint === 'string' && trap.hint.length > 5, `${label}: hint ${opt.key}`);
    assert(typeof trap.explanation === 'string' && trap.explanation.length > 5, `${label}: explanation ${opt.key}`);
    const left = trap.diff?.left?.trim();
    const right = trap.diff?.right?.trim();
    if (left || right) {
      assert(left && right, `${label}: diff ${opt.key} needs both sides`);
      assert(contains(evidenceText, left), `${label}: diff left "${left}" must appear in correct evidence`);
      assert(contains(opt.text, right) || contains(answerText, right), `${label}: diff right "${right}" must appear in an option`);
    }
  }
  assert(typeof item.correctNote === 'string' && item.correctNote.length > 5, `${label}: correct note`);
}

for (const preset of LAB_PRESETS) {
  console.log(`preset: ${preset.id} (${preset.tag})`);
  assert(ERROR_LABELS[preset.errorType], `${preset.id}: known error type`);
  validateItem(preset.id, preset);
  validateItem(`${preset.id}/transfer`, preset.transfer);
}

for (const type of listTransferTypes()) {
  const item = pickTransfer(type, 0);
  console.log(`bank: ${item.id} (${item.errorType})`);
  assert(item.errorType === type, `bank ${type}: type matches`);
  validateItem(`bank/${item.id}`, item);
}

// fallback: unknown type still returns a usable vetted item
{
  const item = pickTransfer('not_a_real_type', 0);
  assert(item && item.question && item.evidence, 'fallback transfer item is usable');
}

console.log(fail === 0 ? 'LAB DATA TESTS: PASS' : `LAB DATA TESTS: ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
