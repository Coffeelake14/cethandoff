// DEV ONLY — data integrity for the preset lab, transfer bank and RAG corpus.
// Guards answer/evidence fixtures, error-cause labels, provenance, source
// traceability, client/server transfer parity and the actual question count.
// Run: node dev/test-lab.mjs
import { readFileSync } from 'node:fs';
import { LAB_PRESETS, LAB_ITEM_COUNT, LAB_SOURCE_LABEL, ERROR_LABELS } from '../web/lab-data.js';
import { pickTransfer, listTransferTypes } from '../functions/lab-bank.mjs';
import { CORPUS } from '../functions/corpus.mjs';
import { retrieve, formatContext } from '../functions/rag.mjs';

let fail = 0;
const assert = (cond, msg) => { if (!cond) { fail++; console.log('ASSERT FAIL:', msg); } };
const equal = (actual, expected, msg) => assert(JSON.stringify(actual) === JSON.stringify(expected), `${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
const norm = s => String(s).toLowerCase().replace(/\s+/g, ' ').trim();
const contains = (text, word) => norm(text).includes(norm(word));
const STALE_TEXT = new RegExp(`近\\s*5\\s*年|${'20' + '20'}|${'20' + '24'}`);
const HUMAN_REVIEW_CLAIM = new RegExp(`${'人工' + '核对'}|${'人工' + '审核'}|${'人工' + '审阅'}|human[ -]checked|${'hand-' + 'written'}`, 'i');
const canonical = value => Array.isArray(value)
  ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
    : value;

const PROVENANCE = { kind: 'original', answerBasis: '原文逐句核对', verifiedAt: '2026-11-24' };
const EXPECTED_ITEMS = {
  'screen-reading': {
    errorType: 'scope_expansion', answer: 'B', evidence: ['s5', 's6'],
    traps: { A: 'scope_expansion', C: 'scope_expansion', D: 'scope_expansion' },
  },
  'music-anxiety': {
    errorType: 'causal_inversion', answer: 'B', evidence: ['s3'],
    traps: { A: 'not_supported', C: 'detail_mismatch', D: 'detail_mismatch' },
  },
  'online-courses': {
    errorType: 'attitude_shift', answer: 'C', evidence: ['s3', 's4', 's5'],
    traps: { A: 'attitude_shift', B: 'attitude_shift', D: 'not_supported' },
  },
  'transfer-coffee': {
    errorType: 'scope_expansion', answer: 'B', evidence: ['s2'],
    traps: { A: 'scope_expansion', C: 'scope_expansion', D: 'detail_mismatch' },
  },
  'transfer-exercise': {
    errorType: 'causal_inversion', answer: 'B', evidence: ['s3'],
    traps: { A: 'not_supported', C: 'scope_expansion', D: 'detail_mismatch' },
  },
  'transfer-screens': {
    errorType: 'attitude_shift', answer: 'C', evidence: ['s3', 's4', 's5'],
    traps: { A: 'scope_expansion', B: 'attitude_shift', D: 'not_supported' },
  },
};

function validateItem(label, item) {
  const expected = EXPECTED_ITEMS[item.id];
  assert(expected, `${label}: item is part of the six-question fixture`);
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
  q.options.forEach(option => assert(typeof option.text === 'string' && option.text.trim().length > 5, `${label}: option text ${option.key}`));
  const keys = new Set(q.options.map(o => o.key));
  assert(keys.size === 4 && ['A', 'B', 'C', 'D'].every(k => keys.has(k)), `${label}: option keys A-D`);
  assert(keys.has(q.answer), `${label}: answer is a real option`);
  assert(Array.isArray(item.evidence) && item.evidence.length, `${label}: correct evidence present`);
  equal(new Set(item.evidence).size, item.evidence.length, `${label}: evidence ids are unique`);
  assert(item.evidence.every(id => ids.has(id)), `${label}: correct evidence ids exist`);

  equal(canonical(item.provenance), canonical(PROVENANCE), `${label}: provenance`);
  equal(item.sourceLabel, LAB_SOURCE_LABEL, `${label}: source label`);
  equal(LAB_SOURCE_LABEL, '原创题 · 原文核对', 'shared source label wording');
  if (expected) {
    equal(item.errorType, expected.errorType, `${label}: error-cause focus`);
    equal(q.answer, expected.answer, `${label}: reviewed answer`);
    equal(item.evidence, expected.evidence, `${label}: reviewed answer evidence`);
  }

  const answerText = q.options.find(o => o.key === q.answer).text;
  const evidenceText = item.evidence.map(id => sentences.find(s => s.id === id).text).join(' ');
  const wrongKeys = q.options.filter(o => o.key !== q.answer).map(o => o.key).sort();
  equal(Object.keys(item.traps || {}).sort(), wrongKeys, `${label}: traps cover exactly the wrong options`);

  for (const opt of q.options) {
    if (opt.key === q.answer) continue;
    const trap = item.traps?.[opt.key];
    assert(trap && ERROR_LABELS[trap.type], `${label}: known trap type for ${opt.key}`);
    if (!trap) continue;
    if (expected) equal(trap.type, expected.traps[opt.key], `${label}: reviewed error-cause label ${opt.key}`);
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

equal(LAB_PRESETS.length, 3, 'three preset questions');
const presetTransfers = LAB_PRESETS.map(preset => preset.transfer);
equal(presetTransfers.filter(Boolean).length, 3, 'three transfer questions');
equal(LAB_ITEM_COUNT, LAB_PRESETS.length + presetTransfers.filter(Boolean).length, 'exported count is derived from actual items');
equal(LAB_ITEM_COUNT, 6, 'actual total question count');
equal(new Set([...LAB_PRESETS, ...presetTransfers].map(item => item.id)).size, 6, 'six unique question ids');

for (const preset of LAB_PRESETS) {
  console.log(`preset: ${preset.id} (${preset.tag})`);
  assert(ERROR_LABELS[preset.errorType], `${preset.id}: known error type`);
  validateItem(preset.id, preset);
  validateItem(`${preset.id}/transfer`, preset.transfer);
  const bankItem = pickTransfer(preset.errorType, 0);
  equal(canonical(bankItem), canonical(preset.transfer), `${preset.id}: server bank exactly matches client transfer`);
}

for (const type of listTransferTypes()) {
  const item = pickTransfer(type, 0);
  console.log(`bank: ${item.id} (${item.errorType})`);
  assert(item.errorType === type, `bank ${type}: type matches`);
  validateItem(`bank/${item.id}`, item);
}

// fallback: unknown type still returns a usable source-traceable item
{
  const item = pickTransfer('not_a_real_type', 0);
  assert(item && item.question && item.evidence, 'fallback transfer item is usable');
  validateItem('bank/fallback', item);
}

// Every corpus entry carries a traceable source.
const OFFICIAL_OUTLINE_URL = 'https://cet.neea.edu.cn/html1/folder/16113/1588-1.htm';
const OFFICIAL_STRUCTURE_URL = 'https://cet.neea.edu.cn/html1/folder/16113/1586-1.htm';
equal(new Set(CORPUS.map(item => item.id)).size, CORPUS.length, 'corpus ids are unique');
for (const item of CORPUS) {
  const source = item.source;
  assert(source && typeof source.id === 'string' && source.id.trim(), `${item.id}: source id`);
  assert(source && typeof source.title === 'string' && source.title.trim(), `${item.id}: source title`);
  assert(source && ['official', 'original'].includes(source.kind), `${item.id}: source kind`);
  if (source.kind === 'official') assert([OFFICIAL_OUTLINE_URL, OFFICIAL_STRUCTURE_URL].includes(source.url), `${item.id}: verified official URL`);
  if (source.kind === 'original') {
    equal(source.title, '项目原创备考方法整理', `${item.id}: original source title`);
    assert(!source.url, `${item.id}: original source has no invented URL`);
  }
  assert(!STALE_TEXT.test(item.text), `${item.id}: no stale year range`);
}
assert(CORPUS.some(item => item.source.title.includes('考试大纲') && item.source.url === OFFICIAL_OUTLINE_URL), 'official outline is cited');
assert(CORPUS.some(item => item.source.title.includes('《CET笔试》') && item.source.url === OFFICIAL_STRUCTURE_URL), 'official test structure is cited');
for (const id of ['L-practice', 'R-practice', 'T-practice']) {
  const item = CORPUS.find(entry => entry.id === id);
  assert(item?.text.includes('样题') && !item.text.includes('历年公开'), `${id}: describes published sample questions`);
}

// Snapshot the pre-change retrieval order so adding source metadata cannot
// silently alter scoring, selection or top-K behavior.
const RETRIEVAL_CASES = [
  ['CET4', ['listening'], ['L-news-vocab', 'L-practice', 'L-pass-skill', 'L-conv-vocab', 'L-news-skill', 'L-conv-skill', 'G-plan', 'G-vocab-core']],
  ['CET4', ['reading'], ['G-vocab-core', 'R-practice', 'R-banked-vocab', 'R-match-skill', 'R-careful-vocab', 'R-careful-skill', 'R-banked-skill', 'L-news-vocab']],
  ['CET4', ['writing', 'translation'], ['W-vocab', 'W-skill', 'T-vocab-culture', 'T-practice', 'W-template', 'T-vocab-society', 'W-sentences', 'T-skill']],
  ['CET4', ['listening', 'reading', 'writing', 'translation'], ['L-news-vocab', 'L-practice', 'G-vocab-core', 'R-practice', 'W-vocab', 'W-skill', 'T-vocab-culture', 'T-practice']],
  ['CET6', ['listening'], ['L-conv-vocab', 'L-practice', 'L-pass-skill', 'L-news-skill', 'L-conv-skill', 'G-plan', 'G-vocab-core6', 'R-banked-vocab']],
  ['CET6', ['reading'], ['G-vocab-core6', 'R-practice', 'R-banked-vocab', 'R-match-skill', 'R-careful-vocab', 'R-careful-skill', 'R-banked-skill', 'L-conv-vocab']],
  ['CET6', ['writing', 'translation'], ['W-vocab', 'W-skill', 'T-vocab-culture', 'T-practice', 'W-template', 'T-vocab-society', 'W-sentences', 'T-skill']],
  ['CET6', ['listening', 'reading', 'writing', 'translation'], ['L-conv-vocab', 'L-practice', 'G-vocab-core6', 'R-practice', 'W-vocab', 'W-skill', 'T-vocab-culture', 'T-practice']],
];
for (const [level, weakModules, expectedIds] of RETRIEVAL_CASES) {
  equal(retrieve(level, weakModules).map(item => item.id), expectedIds, `retrieve order ${level}/${weakModules.join(',')}`);
}

const contextItems = retrieve('CET4', ['listening'], 2);
const context = formatContext(contextItems);
contextItems.forEach((item, index) => {
  assert(context.includes(`[资料 ${index + 1}] 资料编号：${item.id}`), `context ${item.id}: material number and id`);
  assert(context.includes(`标题：${item.title}`), `context ${item.id}: title`);
  assert(context.includes(`来源：${item.source.title}`), `context ${item.id}: source`);
  assert(context.includes(item.text), `context ${item.id}: passage text`);
  if (item.source.url) assert(context.includes(`来源链接：${item.source.url}`), `context ${item.id}: source URL`);
});

// Check all runtime data/source files, not just imported values, for stale
// ranges and unsupported claims of human review.
const TARGET_FILES = [
  '../functions/corpus.mjs',
  '../functions/rag.mjs',
  '../functions/lab-bank.mjs',
  '../web/lab-data.js',
];
for (const path of TARGET_FILES) {
  const text = readFileSync(new URL(path, import.meta.url), 'utf8');
  assert(!STALE_TEXT.test(text), `${path}: no stale year range`);
  assert(!HUMAN_REVIEW_CLAIM.test(text), `${path}: no claim of human review`);
}

console.log(fail === 0 ? 'LAB DATA TESTS: PASS' : `LAB DATA TESTS: ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
