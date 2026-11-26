import test from 'node:test';
import assert from 'node:assert/strict';

class MemoryStorage {
  constructor(failWrites = false) { this.data = new Map(); this.failWrites = failWrites; }
  get length() { return this.data.size; }
  key(index) { return [...this.data.keys()][index] ?? null; }
  getItem(key) { return this.data.get(key) ?? null; }
  setItem(key, value) { if (this.failWrites) throw new Error('full'); this.data.set(key, value); }
  removeItem(key) { this.data.delete(key); }
}

const store = new MemoryStorage();
globalThis.localStorage = store;
const history = await import('../web/command-history.js');

const material = { id: 'screen-reading', level: 'CET4', referenceAnswer: '' };
const diagnosis = {
  source: 'verified', error_type: 'scope_expansion', answer_correct: false,
  correct_option: 'B', alignment: 'aligned', correct_evidence_ids: ['s5', 's6'],
};
const attempt = { choice: 'A', evidence: ['s5'], confidence: 'medium' };
const reanswer = { choice: 'B', evidence: ['s5'], confidence: 'medium' };

test('main result records only judgeable structured fields and is idempotent', () => {
  const record = history.recordMain({ attemptId: 'attempt-main-1', material, diagnosis, attempt, reanswer, submittedAt: 1000 });
  assert.equal(record.kind, 'main');
  assert.equal(record.firstAnswer.judgeable, true);
  assert.equal(record.evidence.aligned, true);
  assert.equal(record.reanswer.correct, true);
  assert.equal(history.recordMain({ attemptId: 'attempt-main-1', material, diagnosis, attempt, reanswer, submittedAt: 2000 }), null);
  const saved = JSON.parse(store.getItem('cet.command.history.v1.attempt-main-1.main'));
  assert.equal(saved.submittedAt, 1000);
  assert.deepEqual(Object.keys(saved).sort(), ['answer', 'attemptId', 'evidence', 'errorType', 'firstAnswer', 'kind', 'level', 'questionId', 'reanswer', 'source', 'submittedAt'].filter(key => key !== 'answer').sort());
});

test('main and transfer in one attempt are separate records', () => {
  const record = history.recordTransfer({ attemptId: 'attempt-main-1', material: { ...material, id: 'transfer-coffee' }, diagnosis: { ...diagnosis, answer_correct: true }, submittedAt: 1100 });
  assert.equal(record.kind, 'transfer');
  assert.equal(history.listHistory().length, 2);
  const summary = history.summarizeHistory(history.listHistory());
  assert.deepEqual(summary.firstCorrect, { value: '0/1', samples: 1 });
  assert.deepEqual(summary.evidenceAligned, { value: '1/1', samples: 1 });
  assert.deepEqual(summary.reanswerCorrect, { value: '1/1', samples: 1 });
  assert.deepEqual(summary.transferCorrect, { value: '1/1', samples: 1 });
});

test('AI-only correctness is not included in judgeable performance', () => {
  history.recordMain({
    attemptId: 'attempt-ai-1', submittedAt: 1200,
    material: { ...material, id: 'custom' },
    diagnosis: { ...diagnosis, source: 'ai' }, attempt,
  });
  const summary = history.summarizeHistory(history.listHistory());
  assert.equal(summary.firstCorrect.samples, 1);
  assert.equal(history.groupErrorRecords(history.listHistory().filter(record => record.firstAnswer.judgeable)).length, 1);
});

test('missing correct evidence makes alignment unknown', () => {
  const record = history.recordMain({
    attemptId: 'attempt-no-evidence', submittedAt: 1300, material, attempt,
    diagnosis: { ...diagnosis, correct_evidence_ids: [], alignment: 'unknown' },
  });
  assert.equal(record.evidence.judgeable, false);
  assert.equal(record.evidence.aligned, null);
});

test('history retains and persists only the latest 100 records', () => {
  for (let i = 0; i < 101; i++) {
    history.recordTransfer({
      attemptId: `attempt-retention-${i}`, submittedAt: 2000 + i,
      material: { ...material, id: `transfer-${i}` }, diagnosis: { ...diagnosis, answer_correct: true },
    });
  }
  assert.equal(history.listHistory().length, 100);
  assert.equal(history.listHistory()[0].attemptId, 'attempt-retention-100');
  assert.equal(store.length, 100);
});

test('unavailable storage still provides session records and warning', async () => {
  globalThis.localStorage = new MemoryStorage(true);
  const record = history.recordTransfer({
    attemptId: 'attempt-memory-only', submittedAt: 3000,
    material: { ...material, id: 'transfer-memory' }, diagnosis: { ...diagnosis, answer_correct: true },
  });
  assert.ok(record);
  assert.equal(history.listHistory().some(item => item.attemptId === 'attempt-memory-only'), true);
  assert.equal(history.historyStorageStatus().unavailable, true);
});
