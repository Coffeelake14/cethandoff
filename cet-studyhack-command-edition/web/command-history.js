const PREFIX = 'cet.command.history.v1.';
const LIMIT = 100;
const memoryRecords = new Map();
const writtenKeys = new Set();
let storageWarning = false;

const clone = value => JSON.parse(JSON.stringify(value));
const validBoolean = value => value === true ? true : value === false ? false : null;

export function createAttemptId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function storage() {
  try {
    if (typeof localStorage === 'undefined') throw new Error('unavailable');
    return localStorage;
  } catch {
    storageWarning = true;
    return null;
  }
}

function cleanRecord(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.attemptId !== 'string' || !/^[a-zA-Z0-9-]{4,80}$/.test(value.attemptId)) return null;
  if (!['main', 'transfer'].includes(value.kind)) return null;
  if (!Number.isFinite(value.submittedAt) || value.submittedAt <= 0) return null;
  if (!['CET4', 'CET6'].includes(value.level)) return null;
  if (typeof value.questionId !== 'string' || !value.questionId || value.questionId.length > 100) return null;
  if (typeof value.errorType !== 'string' || !value.errorType || value.errorType.length > 80) return null;
  if (typeof value.source !== 'string' || !value.source || value.source.length > 120) return null;
  const record = {
    attemptId: value.attemptId,
    kind: value.kind,
    submittedAt: value.submittedAt,
    level: value.level,
    questionId: value.questionId,
    errorType: value.errorType,
    firstAnswer: {
      judgeable: validBoolean(value.firstAnswer?.judgeable) === true,
      correct: validBoolean(value.firstAnswer?.correct),
    },
    reanswer: {
      judgeable: validBoolean(value.reanswer?.judgeable) === true,
      correct: validBoolean(value.reanswer?.correct),
    },
    evidence: {
      judgeable: validBoolean(value.evidence?.judgeable) === true,
      aligned: validBoolean(value.evidence?.aligned),
    },
    source: value.source,
  };
  return record;
}

function prune(records) {
  const sorted = [...records.values()].sort((a, b) => b.submittedAt - a.submittedAt || b.attemptId.localeCompare(a.attemptId));
  for (const [key] of records) {
    if (!sorted.slice(0, LIMIT).some(record => recordKey(record) === key)) records.delete(key);
  }
  return sorted.slice(0, LIMIT);
}

function recordKey(record) {
  return `${PREFIX}${record.attemptId}.${record.kind}`;
}

export function listHistory() {
  const store = storage();
  const records = new Map(memoryRecords);
  if (store) {
    try {
      const keys = [];
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i);
        if (key?.startsWith(PREFIX)) keys.push(key);
      }
      for (const key of keys) {
        const record = cleanRecord(JSON.parse(store.getItem(key)));
        if (record) records.set(key, clone(record));
        else store.removeItem(key);
      }
    } catch {
      storageWarning = true;
    }
  }
  const sorted = [...records.entries()].sort((a, b) => b[1].submittedAt - a[1].submittedAt || b[0].localeCompare(a[0])).slice(0, LIMIT);
  return sorted.map(([key, record]) => ({ key, ...record }));
}

function writeRecord(record) {
  const clean = cleanRecord(record);
  if (!clean) return null;
  const key = recordKey(clean);
  if (writtenKeys.has(key) || memoryRecords.has(key)) return null;
  const store = storage();
  if (store) {
    try {
      if (store.getItem(key) !== null) return null;
      store.setItem(key, JSON.stringify(clean));
    } catch {
      storageWarning = true;
    }
  }
  memoryRecords.set(key, clone(clean));
  writtenKeys.add(key);
  prune(memoryRecords);
  const retained = listHistory();
  const retainedKeys = new Set(retained.map(record => record.key));
  if (store) {
    try {
      for (let i = store.length - 1; i >= 0; i--) {
        const storedKey = store.key(i);
        if (storedKey?.startsWith(PREFIX) && !retainedKeys.has(storedKey)) store.removeItem(storedKey);
      }
    } catch {
      storageWarning = true;
    }
  }
  return clean;
}

function diagnosisFields(material, diagnosis) {
  const hasEvidence = Array.isArray(diagnosis.correct_evidence_ids) && diagnosis.correct_evidence_ids.length > 0;
  const locallyCheckable = diagnosis.source === 'verified' || Boolean(material.referenceAnswer && hasEvidence);
  return { hasEvidence, locallyCheckable };
}

export function recordMain({ attemptId, material, diagnosis, attempt, reanswer, submittedAt = Date.now() }) {
  if (!attemptId || !material || !diagnosis || !attempt) return null;
  const { hasEvidence, locallyCheckable } = diagnosisFields(material, diagnosis);
  return writeRecord({
    attemptId,
    kind: 'main',
    submittedAt,
    level: material.level,
    questionId: material.id,
    errorType: diagnosis.error_type,
    firstAnswer: {
      judgeable: locallyCheckable,
      correct: diagnosis.answer_correct === true,
    },
    reanswer: {
      judgeable: locallyCheckable && diagnosis.answer_correct === false && Boolean(reanswer),
      correct: reanswer ? reanswer.choice === diagnosis.correct_option : null,
    },
    evidence: {
      judgeable: hasEvidence,
      aligned: hasEvidence ? diagnosis.alignment === 'aligned' : null,
    },
    source: diagnosis.source === 'ai'
      ? (material.referenceAnswer ? '用户提供的参考答案 · AI 诊断' : '答案与错因由 AI 判断')
      : '答案与证据：原创题原文核对',
  });
}

export function recordTransfer({ attemptId, material, diagnosis, submittedAt = Date.now() }) {
  if (!attemptId || !material || !diagnosis) return null;
  return writeRecord({
    attemptId,
    kind: 'transfer',
    submittedAt,
    level: material.level,
    questionId: material.id,
    errorType: diagnosis.error_type,
    firstAnswer: {
      judgeable: diagnosis.source === 'verified',
      correct: diagnosis.answer_correct === true,
    },
    reanswer: { judgeable: false, correct: null },
    evidence: {
      judgeable: diagnosis.correct_evidence_ids?.length > 0,
      aligned: diagnosis.correct_evidence_ids?.length > 0 ? diagnosis.alignment === 'aligned' : null,
    },
    source: diagnosis.source === 'ai'
      ? (material.referenceAnswer ? '用户提供的参考答案 · AI 诊断' : '答案与错因由 AI 判断')
      : '答案与证据：原创题原文核对',
  });
}

export function historyStorageStatus() {
  listHistory();
  return { unavailable: storageWarning };
}

export function summarizeHistory(records) {
  const main = records.filter(record => record.kind === 'main');
  const firstCorrect = main.filter(record => record.firstAnswer.judgeable);
  const evidence = main.filter(record => record.evidence.judgeable);
  const reanswer = main.filter(record => record.reanswer.judgeable);
  const transfer = records.filter(record => record.kind === 'transfer');
  const ratio = (hits, samples) => samples.length ? `${hits}/${samples.length}` : '—';
  return {
    mainCount: main.length,
    firstCorrect: { value: ratio(firstCorrect.filter(record => record.firstAnswer.correct).length, firstCorrect), samples: firstCorrect.length },
    evidenceAligned: { value: ratio(evidence.filter(record => record.evidence.aligned).length, evidence), samples: evidence.length },
    reanswerCorrect: { value: ratio(reanswer.filter(record => record.reanswer.correct).length, reanswer), samples: reanswer.length },
    transferCorrect: { value: ratio(transfer.filter(record => record.firstAnswer.correct && record.evidence.aligned).length, transfer), samples: transfer.length },
  };
}

export function groupErrorRecords(records) {
  const groups = new Map();
  for (const record of records.filter(item => item.kind === 'main')) {
    if (!groups.has(record.errorType)) groups.set(record.errorType, { errorType: record.errorType, count: 0, latest: 0, sources: new Set() });
    const group = groups.get(record.errorType);
    group.count++;
    group.latest = Math.max(group.latest, record.submittedAt);
    group.sources.add(record.source);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || b.latest - a.latest).map(group => ({ ...group, sources: [...group.sources] }));
}
