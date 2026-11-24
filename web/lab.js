// 四六级阅读错因实验室 — the default reading entry.
//
// Full flow: choose material -> choose answer + click passage sentences as
// evidence + pick confidence -> a short hint that never reveals the answer ->
// re-answer -> result with the correct option, the student's evidence, the
// correct evidence and an error-cause evidence card -> a same-type transfer
// question on fresh material -> a summary grounded only in this attempt.
//
// Preset materials are human-checked and diagnosed locally (offline). User
// passages go through the `train` action (real Qoder Cloud Agents) and every
// returned sentence id / contrast word is validated against the passage before
// anything is displayed. Current progress is saved to localStorage only.
import { LAB_PRESETS, LAB_ITEM_COUNT, ERROR_LABELS, findPreset } from './lab-data.js';
import { escapeHtml } from './markdown.js';
import { consumeSSE } from './sse.mjs';
import { aiErrorMessage, isFeatureEnabled, onCapabilities, refreshCapabilities, requireFeature, toast } from './shell.js';
import { photoFileError, transcribePhoto, confidenceLabel, highlightUncertain, wirePhotoDropPaste } from './scan.js';

const $ = id => document.getElementById(id);
const labStage = $('labStage');
const labEmpty = $('labEmpty');
const SAVE_KEY = 'cet.lab.v1';
const CONF_LABEL = { high: '高', medium: '中', low: '低' };
const STEP_LABELS = ['选材料', '作答', '短提示', '看错因', '同类题', '本次结果'];

const state = {
  screen: 'pick', // pick | custom | answer | hint | result | transfer | summary
  mode: 'preset',
  material: null,
  customForm: null,
  draft: { choice: '', evidence: [], confidence: 'medium' },
  attempt: null,
  reanswer: null,
  pendingDiagnosis: null,
  diagnosis: null,
  awaiting: false,
  loading: false,
  loadingMsg: '',
  error: '',
  transfer: null,
};

// Photo import for the custom-material passage. Photos stay in memory; only
// the recognised text is written into the saved custom form.
const customScan = {
  busy: false, lastFile: null, controller: null, tone: '', text: '', preview: '',
  retry: false, rotate: 0, doc: null, qIndex: 0,
};

/* ---------------- data shaping ---------------- */
function normalizeTransfer(source, errorType, origin = 'preset') {
  return {
    id: source.id,
    origin,
    title: source.title,
    level: source.level || 'CET4',
    tag: source.tag || ERROR_LABELS[errorType] || '同类题',
    sentences: source.passage || source.sentences,
    question: source.question,
    evidence: source.evidence,
    traps: source.traps || {},
    correctNote: source.correctNote || '',
    sourceLabel: origin === 'preset' ? '预置同类题 · 原创题 · 原文核对' : '内置同类题 · 原创题 · 原文核对',
  };
}

function normalizePreset(preset) {
  return {
    id: preset.id,
    mode: 'preset',
    level: preset.level,
    title: preset.title,
    tag: preset.tag,
    sentences: preset.passage,
    question: preset.question,
    evidence: preset.evidence,
    traps: preset.traps,
    correctNote: preset.correctNote,
    transfer: normalizeTransfer(preset.transfer, preset.errorType),
    referenceAnswer: '',
    sourceLabel: '原创题 · 原文核对',
  };
}

function normalizeCustomMaterial(raw) {
  if (!raw || !Array.isArray(raw.sentences) || !raw.question) return null;
  const options = Array.isArray(raw.question.options) ? raw.question.options : [];
  if (!options.length || options.length !== 4) return null;
  return {
    id: 'custom',
    mode: 'custom',
    level: raw.level === 'CET6' ? 'CET6' : 'CET4',
    title: '自带材料',
    tag: 'AI 诊断',
    sentences: raw.sentences,
    question: { stem: raw.question.stem, options, answer: '' },
    evidence: [],
    traps: {},
    correctNote: '',
    transfer: null,
    referenceAnswer: raw.referenceAnswer || '',
    sourceLabel: '自带材料 · AI 诊断',
  };
}

function findSentence(material, id) {
  return material?.sentences.find(s => s.id === id) || null;
}

function optionText(material, key) {
  const opt = material?.question.options.find(o => o.key === key);
  return opt ? opt.text : '';
}

/* ---------------- local (vetted) diagnosis ---------------- */
function diagnoseVerified(item, attempt) {
  const correct = item.question.answer;
  const answerCorrect = attempt.choice === correct;
  const correctEvidence = item.evidence.slice();
  const aligned = attempt.evidence.some(id => correctEvidence.includes(id));
  let type = 'none';
  let hint = '回到原文核对：你的依据是否直接支撑该选项的关键信息？';
  let explanation = item.correctNote || '';
  let diff = { left: '', right: '' };

  if (!answerCorrect) {
    const trap = item.traps?.[attempt.choice] || {};
    type = trap.type || 'detail_mismatch';
    diff = trap.diff || { left: '', right: '' };
    hint = trap.hint || '回到原文核对你的依据是否直接支撑正确选项。';
    explanation = trap.explanation || item.correctNote || '';
  } else if (!attempt.evidence.length) {
    type = 'evidence_insufficient';
    hint = '你还没有点选原文依据，回到原文选一句最直接的。';
    explanation = '答案正确，但缺少可核对的依据。';
  } else if (!aligned) {
    type = 'right_answer_wrong_evidence';
    hint = '回到原文核对：你选的依据是否落在关键句上？';
    explanation = `答案对了，但所选依据没有覆盖关键句。${item.correctNote || ''}`;
  } else if (attempt.confidence === 'low') {
    type = 'right_answer_uncertain';
    hint = '回到原文再确认一次：关键句是否真的支撑该选项？';
    explanation = item.correctNote || '答案与依据都正确。';
  }
  if (type === 'none') hint = '回到原文核对：你的依据是否直接支撑该选项的关键信息？';

  return {
    answer_correct: answerCorrect,
    chosen: attempt.choice,
    correct_option: correct,
    error_type: type,
    student_evidence_ids: attempt.evidence.slice(),
    correct_evidence_ids: correctEvidence,
    english_diff: diff,
    hint,
    explanation,
    confidence: attempt.confidence,
    alignment: aligned ? 'aligned' : (attempt.evidence.length ? 'misaligned' : 'unknown'),
    source: 'verified',
  };
}

// Validate a model diagnosis against the exact passage / options we sent, and
// re-derive correctness from the confirmed correct option.
function normalizeDiagnosis(raw, material, attempt) {
  if (!raw || typeof raw !== 'object') return null;
  const ids = new Set(material.sentences.map(s => s.id));
  const keys = new Set(material.question.options.map(o => o.key));
  const rawCorrect = typeof raw.correct_option === 'string' ? raw.correct_option.trim().toUpperCase() : '';
  const correct = keys.has(rawCorrect)
    ? rawCorrect
    : (material.referenceAnswer && keys.has(material.referenceAnswer) ? material.referenceAnswer : null);
  if (!correct) return null;
  const unique = list => [...new Set((Array.isArray(list) ? list : []).filter(id => typeof id === 'string' && ids.has(id)))].slice(0, 4);
  const correctEvidence = unique(raw.correct_evidence_ids);
  // Always display the evidence the student actually clicked, not a model echo.
  const studentEvidence = unique(attempt.evidence);
  const answerCorrect = attempt.choice === correct;
  const overlaps = studentEvidence.some(id => correctEvidence.includes(id));

  let type = ERROR_LABELS[raw.error_type] ? raw.error_type : (answerCorrect ? 'none' : 'detail_mismatch');
  if (answerCorrect) {
    if (!studentEvidence.length || !correctEvidence.length) type = 'evidence_insufficient';
    else if (!overlaps) type = 'right_answer_wrong_evidence';
    else if (attempt.confidence === 'low') type = 'right_answer_uncertain';
    else type = 'none';
  } else if (!correctEvidence.length) {
    type = 'evidence_insufficient';
  }

  const clean = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
  return {
    answer_correct: answerCorrect,
    chosen: attempt.choice,
    correct_option: correct,
    error_type: type,
    student_evidence_ids: studentEvidence,
    correct_evidence_ids: correctEvidence,
    english_diff: {
      left: clean(raw.english_diff?.left, 60),
      right: clean(raw.english_diff?.right, 60),
    },
    hint: clean(raw.hint, 120) || '回到原文核对你的依据是否直接支撑正确选项。',
    explanation: clean(raw.explanation, 300),
    confidence: attempt.confidence,
    alignment: overlaps ? 'aligned' : (studentEvidence.length ? 'misaligned' : 'unknown'),
    source: 'ai',
  };
}

/* ---------------- persistence ---------------- */
let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveState, 250);
}

function saveState() {
  try {
    const data = {
      v: 1,
      screen: state.screen,
      mode: state.mode,
      presetId: state.mode === 'preset' ? state.material?.id || null : null,
      customMaterial: state.mode === 'custom' ? state.material : null,
      customForm: state.customForm,
      draft: state.draft,
      attempt: state.attempt,
      reanswer: state.reanswer,
      pendingDiagnosis: state.pendingDiagnosis,
      diagnosis: state.diagnosis,
      awaiting: state.awaiting,
      transfer: state.transfer
        ? { item: state.transfer.item, draft: state.transfer.draft, attempt: state.transfer.attempt, diagnosis: state.transfer.diagnosis }
        : null,
    };
    localStorage.setItem(SAVE_KEY, JSON.stringify(data));
  } catch { /* storage full */ }
}

function isCloudRequestId(requestId) {
  return typeof requestId === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(requestId);
}

function restoreState() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null'); } catch { return false; }
  if (!saved || saved.v !== 1) return false;
  state.mode = saved.mode === 'custom' ? 'custom' : 'preset';
  state.customForm = saved.customForm || null;
  if (state.mode === 'preset') {
    const preset = findPreset(saved.presetId);
    if (preset) state.material = normalizePreset(preset);
  } else {
    state.material = normalizeCustomMaterial(saved.customMaterial);
  }
  if (saved.draft) state.draft = { choice: saved.draft.choice || '', evidence: Array.isArray(saved.draft.evidence) ? saved.draft.evidence.slice(0, 3) : [], confidence: saved.draft.confidence || 'medium' };
  state.attempt = saved.attempt || null;
  state.reanswer = saved.reanswer || null;
  const canRestore = diagnosis => state.mode === 'preset' || isCloudRequestId(diagnosis?.requestId);
  state.pendingDiagnosis = canRestore(saved.pendingDiagnosis) ? saved.pendingDiagnosis || null : null;
  state.diagnosis = canRestore(saved.diagnosis) ? saved.diagnosis || null : null;
  state.awaiting = Boolean(saved.awaiting);
  if (saved.transfer?.item && (state.mode === 'preset' || state.diagnosis)) {
    state.transfer = {
      item: normalizeTransfer(saved.transfer.item, state.diagnosis?.error_type, state.mode === 'preset' ? 'preset' : 'ai'),
      draft: saved.transfer.draft || { choice: '', evidence: [], confidence: 'medium' },
      attempt: saved.transfer.attempt || null,
      diagnosis: saved.transfer.diagnosis || null,
      loading: false,
      error: '',
    };
  }

  let screen = saved.screen || 'pick';
  if (screen === 'custom') {
    if (!state.customForm) state.customForm = blankCustomForm();
  } else if (['answer', 'hint', 'result', 'summary'].includes(screen)) {
    if (!state.material) screen = 'pick';
    else if (screen === 'hint' && !state.pendingDiagnosis) screen = 'answer';
    else if ((screen === 'result' || screen === 'summary') && !state.diagnosis) screen = state.attempt ? 'answer' : 'pick';
  } else if (screen === 'transfer') {
    if (!state.material || !state.transfer?.item) screen = state.diagnosis ? 'result' : (state.attempt ? 'answer' : 'pick');
  } else {
    screen = 'pick';
  }
  state.screen = screen;
  return screen !== 'pick';
}

/* ---------------- rendering helpers ---------------- */
function markWord(text, word) {
  const idx = String(text).toLowerCase().indexOf(String(word).toLowerCase());
  if (idx < 0) return escapeHtml(text);
  return escapeHtml(text.slice(0, idx))
    + '<mark>' + escapeHtml(text.slice(idx, idx + word.length)) + '</mark>'
    + escapeHtml(text.slice(idx + word.length));
}

function contains(text, word) {
  const norm = value => String(value).toLowerCase().replace(/\s+/g, ' ').trim();
  return norm(text).includes(norm(word));
}

function stepBar(active) {
  return `<div class="stepbar" aria-hidden="true">${STEP_LABELS.map((label, i) => {
    const n = i + 1;
    const cls = n === active ? 'active' : n < active ? 'done' : '';
    return `<span class="step ${cls}"><i>${n}</i>${escapeHtml(label)}</span>`;
  }).join('')}</div>`;
}

function stageHead(kicker, title, extra = '') {
  return `<div class="stage-head">
    <div class="sh-main">
      <span class="stage-kicker">${escapeHtml(kicker)}</span>
      <h2>${escapeHtml(title)}</h2>
    </div>
    <div class="sh-actions">${extra}<button type="button" class="btn btn-sm btn-ghost" data-act="restart"><svg><use href="#i-refresh"/></svg>从头开始</button></div>
  </div>`;
}

function renderPassage(material, { interactive = false, selected = new Set(), correct = new Set(), student = new Set() } = {}) {
  const paras = new Map();
  for (const s of material.sentences) {
    if (!paras.has(s.para)) paras.set(s.para, []);
    paras.get(s.para).push(s);
  }
  const inner = [...paras.entries()].sort((a, b) => a[0] - b[0]).map(([, list]) => {
    const pieces = list.map(s => {
      const cls = ['sent'];
      if (interactive && selected.has(s.id)) cls.push('sel');
      if (correct.has(s.id)) cls.push('ev-hi');
      if (student.has(s.id)) cls.push('ev-stu');
      const attrs = `data-sid="${escapeHtml(s.id)}"`;
      if (interactive) {
        return `<button type="button" class="${cls.join(' ')}" data-act="sent" ${attrs} aria-pressed="${selected.has(s.id)}">${escapeHtml(s.text)}</button>`;
      }
      return `<span class="${cls.join(' ')}" ${attrs}>${escapeHtml(s.text)}</span>`;
    }).join(' ');
    return `<p>${pieces}</p>`;
  }).join('');
  return `<div class="passage${interactive ? ' interactive' : ''}">${inner}</div>`;
}

function optionList(material, draft) {
  return `<div class="option-list">${material.question.options.map(o => {
    const on = draft.choice === o.key;
    return `<button type="button" class="opt-btn${on ? ' sel' : ''}" data-act="opt" data-key="${o.key}" aria-pressed="${on}">
      <span class="opt-key">${o.key}</span><span class="opt-text">${escapeHtml(o.text)}</span>
    </button>`;
  }).join('')}</div>`;
}

function confidenceRow(draft) {
  return `<div class="conf-row" role="group" aria-label="信心程度">
    ${[['high', '高'], ['medium', '中'], ['low', '低']].map(([key, label]) => `
      <button type="button" class="conf-btn${draft.confidence === key ? ' sel' : ''}" data-act="conf" data-conf="${key}" aria-pressed="${draft.confidence === key}">${label}</button>`).join('')}
    <span class="conf-note">选错但信心高，往往说明判断依据需要重点复盘。</span>
  </div>`;
}

function evidencePicker(draft) {
  return `<div class="evidence-pick">
    <div class="ep-head"><span>点选原文句子作为依据</span><b class="ep-count">已选 ${draft.evidence.length} 句依据</b></div>
    <p class="ep-hint">在上方原文中点句子；再点一次取消。建议只选最直接支撑选项的 1–2 句。</p>
  </div>`;
}

/* ---------------- screens ---------------- */
function answerHtml() {
  const m = state.material;
  const d = state.draft;
  const reanswer = state.awaiting;
  const aiUnavailable = m.mode === 'custom' && !isFeatureEnabled('train');
  return `
    ${stageHead(m.sourceLabel, m.title)}
    ${stepBar(reanswer ? 4 : 2)}
    ${aiUnavailable ? '<div class="lab-error" role="alert"><b>暂不可用</b><p>AI 诊断暂不可用，请重试。</p><button type="button" class="btn btn-sm" data-act="capabilities-retry"><svg><use href="#i-refresh"/></svg>重试</button></div>' : ''}
    ${state.error ? `<div class="lab-error" role="alert"><b>诊断失败</b><p>${escapeHtml(state.error)}</p><button type="button" class="btn btn-sm" data-act="retry-train"><svg><use href="#i-refresh"/></svg>重试诊断</button></div>` : ''}
    ${state.loading ? `<div class="lab-loading"><span class="spin"></span>${escapeHtml(state.loadingMsg || '正在核对你的选项与依据…')}</div>` : ''}
    ${reanswer ? `<div class="hint-banner"><span class="tag warn">首答短提示</span><p>${escapeHtml(state.pendingDiagnosis?.hint || '回到原文核对你的依据。')}</p></div>` : ''}
    <section class="card stage-card">
      <div class="card-head">
        <span class="chip t"><svg><use href="#i-book"/></svg></span>
        <div><h2>阅读材料</h2><p class="hint">${escapeHtml(m.tag)} · ${m.level === 'CET6' ? '六级' : '四级'}</p></div>
        <span class="grow"></span>
        <span class="pill">${reanswer ? '重答' : '第 1 步'}</span>
      </div>
      <div class="card-body">${renderPassage(m, { interactive: !state.loading, selected: new Set(d.evidence) })}</div>
    </section>
    <section class="card stage-card">
      <div class="card-body question-body">
        <p class="q-stem">${escapeHtml(m.question.stem)}</p>
        ${optionList(m, d)}
        ${evidencePicker(d)}
        <div class="conf-label">你对这个答案的信心程度</div>
        ${confidenceRow(d)}
        <button type="button" class="btn btn-primary btn-lg" data-act="submit" ${state.loading || aiUnavailable ? 'disabled' : ''}>
          <svg><use href="#i-spark"/></svg>${aiUnavailable ? '暂不可用' : state.loading ? '正在诊断…' : reanswer ? '提交重答并查看结果' : '提交并查看短提示'}
        </button>
        <p class="submit-note">${reanswer ? '提交后会展示正确项、你的证据、正确证据和错因。' : '先给不透露答案的短提示，重答后才展示正确项与错因。'}</p>
      </div>
    </section>`;
}

function hintHtml() {
  const m = state.material;
  const d = state.pendingDiagnosis;
  const a = state.attempt;
  return `
    ${stageHead(m.sourceLabel, m.title)}
    ${stepBar(3)}
    <section class="card stage-card hint-stage">
      <div class="card-body">
        <div class="hint-hero">
          <span class="tag warn">短提示 · 不透露答案</span>
          <p class="hint-text">${escapeHtml(d?.hint || '回到原文核对你的依据是否直接支撑所选选项。')}</p>
        </div>
        <div class="attempt-recap">
          <span>你的首答：<b>${escapeHtml(a?.choice || '—')}</b></span>
          <span>信心：<b>${CONF_LABEL[a?.confidence] || '—'}</b></span>
          <span>已选依据：<b>${a?.evidence.length || 0} 句</b></span>
        </div>
        <div class="stage-actions">
          <button type="button" class="btn btn-primary" data-act="reanswer"><svg><use href="#i-refresh"/></svg>重新作答</button>
          <button type="button" class="btn" data-act="reveal">直接看诊断</button>
        </div>
        <p class="submit-note">建议先根据提示回原文复核，再提交重答。</p>
      </div>
    </section>`;
}

function alignmentLabel(diagnosis) {
  if (diagnosis.alignment === 'aligned') {
    return diagnosis.answer_correct ? '依据与关键句对齐' : '依据在关键句，但选项解读有误';
  }
  if (diagnosis.alignment === 'misaligned') return '依据未落在关键句';
  return '未提供依据';
}

function evidenceList(material, ids, label, tone) {
  const seen = new Set();
  const items = ids.map(id => {
    if (seen.has(id)) return '';
    seen.add(id);
    const s = findSentence(material, id);
    if (!s) return '';
    return `<button type="button" class="ev-sent" data-act="jump" data-id="${escapeHtml(id)}">${escapeHtml(s.text)}</button>`;
  }).filter(Boolean).join('');
  return `<div class="ev-card ${tone}">
    <h4>${escapeHtml(label)}</h4>
    ${items || '<p class="muted small">没有可核对的引句</p>'}
  </div>`;
}

function validatedDiff(diagnosis, material) {
  const left = diagnosis.english_diff?.left?.trim();
  const right = diagnosis.english_diff?.right?.trim();
  if (!left || !right) return null;
  const evidenceSentences = diagnosis.correct_evidence_ids.map(id => findSentence(material, id)).filter(Boolean);
  const leftSentence = evidenceSentences.find(s => contains(s.text, left));
  if (!leftSentence) return null;
  const chosenText = optionText(material, diagnosis.chosen);
  const correctText = optionText(material, diagnosis.correct_option);
  if (!contains(chosenText, right) && !contains(correctText, right)) return null;
  const useCorrect = !contains(chosenText, right) && contains(correctText, right);
  return {
    left, right, leftSentence, useCorrect,
    optionLabel: useCorrect ? '正确选项' : '你的选项',
    option: useCorrect ? correctText : chosenText,
  };
}

function evidenceCard(diagnosis, material) {
  const type = diagnosis.error_type;
  const label = ERROR_LABELS[type] || type;
  const tone = type === 'none' ? 'ok' : (type === 'right_answer_wrong_evidence' || type === 'right_answer_uncertain') ? 'warn' : 'bad';
  const diff = validatedDiff(diagnosis, material);
  const compare = diff ? `
    <div class="compare">
      <div class="cmp-col">
        <div class="cmp-label">原文证据</div>
        <p class="cmp-text">${markWord(diff.leftSentence.text, diff.left)}</p>
        <div class="cmp-mark">原文用词：<mark>${escapeHtml(diff.left)}</mark></div>
      </div>
      <div class="cmp-arrow" aria-hidden="true">≠</div>
      <div class="cmp-col">
        <div class="cmp-label">${escapeHtml(diff.optionLabel)}</div>
        <p class="cmp-text">${markWord(diff.option, diff.right)}</p>
        <div class="cmp-mark">选项用词：<mark>${escapeHtml(diff.right)}</mark></div>
      </div>
    </div>` : '<p class="diff-none">本题没有可并排标记的英文差异，仅给出文字诊断。</p>';
  return `<div class="evidence-card ${tone}">
    <div class="ec-head">
      <span class="tag ${tone}">${escapeHtml(label)}</span>
      <span class="ec-sub">证据卡 · 本次作答</span>
    </div>
    ${compare}
    <p class="ec-explain">${escapeHtml(diagnosis.explanation || '请结合原文再核对一次选项与依据。')}</p>
  </div>`;
}

function judgementSourceLabel(material, diagnosis) {
  if (diagnosis.source === 'ai') {
    return material.referenceAnswer ? '用户提供的参考答案 · AI 诊断' : '答案与错因由 AI 判断';
  }
  return '答案与证据：原创题原文核对';
}

function resultHtml(isTransfer = false) {
  const material = isTransfer ? state.transfer.item : state.material;
  const diagnosis = isTransfer ? state.transfer.diagnosis : state.diagnosis;
  const attempt = isTransfer ? state.transfer.attempt : state.attempt;
  const reanswer = isTransfer ? null : state.reanswer;
  if (!material || !diagnosis || !attempt) return '';
  const canDiagnose = diagnosis.correct_evidence_ids.length > 0;
  const correctText = optionText(material, diagnosis.correct_option);
  const reOk = reanswer ? reanswer.choice === diagnosis.correct_option : null;
  const wrongEvidence = diagnosis.error_type === 'right_answer_wrong_evidence';
  const uncertain = diagnosis.error_type === 'right_answer_uncertain';

  const verdict = `<div class="verdict ${diagnosis.answer_correct ? 'ok' : 'bad'}">
    <div class="v-main">
      <span class="v-dot"></span>
      <b>${isTransfer ? '同类题首答 ' : '首答 '}${escapeHtml(attempt.choice)} ${diagnosis.answer_correct ? '正确' : '错误'}</b>
      <span class="v-sub">正确项 <b>${escapeHtml(diagnosis.correct_option)}</b>：${escapeHtml(correctText)}</span>
    </div>
    ${reanswer ? `<div class="v-re">重答 <b>${escapeHtml(reanswer.choice)}</b> ${reOk ? '正确' : '仍错误'}</div>` : ''}
    <div class="v-meta">信心 ${CONF_LABEL[attempt.confidence] || '—'} · ${alignmentLabel(diagnosis)} · 错因诊断基于首答<br>题目 ID：${escapeHtml(material.id)} · 原文证据 ID：${escapeHtml(diagnosis.correct_evidence_ids.join(' / ') || '无')} · 判断来源：${escapeHtml(judgementSourceLabel(material, diagnosis))}</div>
  </div>`;

  const warning = wrongEvidence
    ? '<div class="lab-warn">答案对了，但你的依据没有落在关键句上——这同样需要修正。</div>'
    : uncertain
      ? '<div class="lab-warn">答案对了，但你的信心偏低；建议再确认一次依据。</div>'
      : '';

  const insufficient = canDiagnose ? '' : `<div class="insufficient">
    <b>证据不够，暂时无法诊断</b>
    <p>${escapeHtml(diagnosis.explanation || '你选择的句子没有定位到关键信息。请重选一句更直接的原文依据。')}</p>
    <div class="stage-actions">
      <button type="button" class="btn" data-act="reselect">重选证据</button>
      <button type="button" class="btn" data-act="pick">换一篇</button>
    </div>
  </div>`;

  return `
    ${stageHead(material.sourceLabel, isTransfer ? state.transfer.item.title : material.title)}
    ${stepBar(isTransfer ? 5 : 4)}
    ${verdict}
    ${warning}
    <section class="card stage-card result-passage">
      <div class="card-head">
        <span class="chip t"><svg><use href="#i-book"/></svg></span>
        <div><h2>原文与依据</h2><p class="hint">正确证据标绿，你的证据标蓝；点下方证据可跳转并高亮</p></div>
      </div>
      <div class="card-body">${renderPassage(material, {
        correct: new Set(diagnosis.correct_evidence_ids),
        student: new Set(diagnosis.student_evidence_ids),
      })}</div>
    </section>
    ${canDiagnose ? `
      <div class="evidence-grid">
        ${evidenceList(material, diagnosis.student_evidence_ids, isTransfer ? '你选的证据' : '你选的证据（首答）', 'student')}
        ${evidenceList(material, diagnosis.correct_evidence_ids, '正确证据', 'correct')}
      </div>
      ${evidenceCard(diagnosis, material)}
    ` : insufficient}
    <div class="stage-actions">
      ${isTransfer
        ? `<button type="button" class="btn btn-primary" data-act="summary"><svg><use href="#i-check"/></svg>查看本次结果</button>
           <button type="button" class="btn" data-act="pick">换一篇</button>`
        : `<button type="button" class="btn btn-primary" data-act="transfer"><svg><use href="#i-arrow"/></svg>做一道同类新题</button>
           <button type="button" class="btn" data-act="summary">查看本次结果</button>`}
    </div>`;
}

function transferAnswerHtml() {
  const tr = state.transfer;
  if (!tr) return '';
  if (tr.loading) {
    return `${stageHead('同类新材料', '正在准备同类题…')}${stepBar(5)}
      <div class="lab-loading"><span class="spin"></span>正在从预置同类题库中匹配题目…</div>`;
  }
  if (tr.error) {
    return `${stageHead('同类新材料', '同类题加载失败')}${stepBar(5)}
      <div class="lab-error" role="alert"><b>加载失败</b><p>${escapeHtml(tr.error)}</p>
        <button type="button" class="btn btn-sm" data-act="retry-transfer"><svg><use href="#i-refresh"/></svg>重试</button></div>`;
  }
  if (tr.diagnosis) return resultHtml(true);
  const m = tr.item;
  const d = tr.draft;
  return `
    ${stageHead(m.sourceLabel, m.title)}
    ${stepBar(5)}
    <div class="transfer-note"><span class="tag t">${escapeHtml(m.tag)}</span> 这是一道陌生材料上的同类题，用来验证你是否能把本次修正迁移到新题。</div>
    <section class="card stage-card">
      <div class="card-head">
        <span class="chip t"><svg><use href="#i-book"/></svg></span>
        <div><h2>陌生材料</h2><p class="hint">${m.level === 'CET6' ? '六级' : '四级'} · 先自己定位依据</p></div>
      </div>
      <div class="card-body">${renderPassage(m, { interactive: true, selected: new Set(d.evidence) })}</div>
    </section>
    <section class="card stage-card">
      <div class="card-body question-body">
        <p class="q-stem">${escapeHtml(m.question.stem)}</p>
        ${optionList(m, d)}
        ${evidencePicker(d)}
        <button type="button" class="btn btn-primary btn-lg" data-act="submit-transfer"><svg><use href="#i-check"/></svg>提交同类题</button>
        <p class="submit-note">提交后立即显示结果；本结果只代表这次作答。</p>
      </div>
    </section>`;
}

function summaryFacts() {
  const d = state.diagnosis;
  const re = state.reanswer;
  const tr = state.transfer?.diagnosis;
  const facts = [];
  if (d) {
    facts.push({
      label: '首答',
      text: `${d.chosen} · ${d.answer_correct ? '正确' : '错误'} · 信心${CONF_LABEL[d.confidence]} · ${alignmentLabel(d)}`,
      tone: d.answer_correct && d.alignment === 'aligned' ? 'ok' : 'bad',
    });
    facts.push({ label: '错因', text: ERROR_LABELS[d.error_type] || d.error_type, tone: d.error_type === 'none' ? 'ok' : 'warn' });
  }
  facts.push({
    label: '重答',
    text: re ? `${re.choice} · ${re.choice === d?.correct_option ? '正确' : '仍错误'}` : '未重答',
    tone: re ? (re.choice === d?.correct_option ? 'ok' : 'bad') : 'muted',
  });
  facts.push({
    label: '同类题',
    text: tr ? `${tr.chosen} · ${tr.answer_correct ? '正确' : '错误'} · 依据${tr.alignment === 'aligned' ? '对齐' : '未对齐'}` : '未完成',
    tone: tr ? (tr.answer_correct && tr.alignment === 'aligned' ? 'ok' : 'bad') : 'muted',
  });
  return facts;
}

function summaryAdvice() {
  const d = state.diagnosis;
  if (!d) return '';
  const re = state.reanswer;
  const tr = state.transfer?.diagnosis;
  const fixed = re && re.choice === d.correct_option;
  if (d.answer_correct && d.alignment === 'aligned') return '本次首答正确且依据对齐；可以换一篇更长的材料验证稳定性。';
  if (d.answer_correct && d.alignment !== 'aligned') return '本次答案对了，但依据没落在关键句上；下次先定位关键句再选项。';
  if (fixed && tr?.answer_correct && tr.alignment === 'aligned') return '本次你先错后改对，并在同类新题上迁移成功；继续坚持“先找依据再选”。';
  if (fixed && tr) return '本次重答已修正，但同类题仍有偏差；回到原文逐句核对数量、因果和态度词。';
  if (fixed) return '本次重答已修正；同类题尚未完成，可继续做一道同类题验证迁移。';
  if (re) return '本次首答与重答仍有偏差；建议先看证据卡里的英文差异，再重做同类题。';
  return '本次首答仍有偏差；建议先看证据卡里的英文差异，再重答或重做同类题。';
}

function summaryHtml() {
  const facts = summaryFacts();
  const advice = summaryAdvice();
  return `
    ${stageHead('本次练习结果', '只基于这一次作答')}
    ${stepBar(6)}
    <div class="summary-note">以下结果只基于本次作答，不代表整体水平，也不是分数预测。</div>
    <div class="fact-list">
      ${facts.map(f => `<div class="fact ${f.tone}"><span class="fact-label">${escapeHtml(f.label)}</span><span class="fact-text">${escapeHtml(f.text)}</span></div>`).join('')}
    </div>
    <div class="summary-note">题目 ID：${escapeHtml(state.material?.id || '—')} · 原文证据 ID：${escapeHtml(state.diagnosis?.correct_evidence_ids.join(' / ') || '无')} · 判断来源：${escapeHtml(state.diagnosis ? judgementSourceLabel(state.material, state.diagnosis) : '—')}</div>
    ${state.transfer?.diagnosis ? `<div class="summary-note">同类题 ID：${escapeHtml(state.transfer.item.id)} · 原文证据 ID：${escapeHtml(state.transfer.diagnosis.correct_evidence_ids.join(' / ') || '无')} · 判断来源：${escapeHtml(judgementSourceLabel(state.transfer.item, state.transfer.diagnosis))}</div>` : ''}
    <div class="advice-card"><span class="tag t">下一步</span><p>${escapeHtml(advice)}</p></div>
    <div class="stage-actions">
      <button type="button" class="btn btn-primary" data-act="pick"><svg><use href="#i-book"/></svg>再练一篇</button>
      <button type="button" class="btn" data-act="restart">重做本篇</button>
    </div>`;
}

function customScanStatusHtml() {
  const tone = customScan.tone ? ` data-state="${customScan.tone}"` : '';
  const hidden = customScan.text ? '' : ' hidden';
  return `<div class="tool-status scan-status" id="lab-scan-status" role="status" aria-live="polite"${tone}${hidden}>${escapeHtml(customScan.text)}</div>`;
}

function customScanPreviewHtml() {
  if (!customScan.preview || customScan.doc) return '';
  return `<div class="scan-preview compact" id="lab-scan-preview">
      <img id="lab-scan-img" src="${customScan.preview}" alt="待识别的原文照片预览" />
      <span>照片会发送到 Qoder Cloud Agents 识别。请先遮住姓名和学号。</span>
    </div>`;
}

function customScanReviewHtml() {
  if (!customScan.preview) return '';
  const doc = customScan.doc || {};
  const transcript = String(doc.passage || doc.text || '').trim();
  const uncertain = Array.isArray(doc.uncertain) ? doc.uncertain : [];
  return `<div class="scan-review" id="lab-scan-review">
      <div class="scan-review-img"><img id="lab-scan-img" src="${customScan.preview}" alt="识别原文照片" /></div>
      <div class="scan-review-text">
        ${transcript
          ? `<div class="scan-review-block"><h4>识别到的原文（保留原始换行）</h4><div>${highlightUncertain(transcript, uncertain)}</div></div>`
          : '<p class="muted">正在识别文字…</p>'}
        <p class="scan-review-note">照片不会存入浏览器草稿；黄色标记为识别不确定处。请在原文框校对后再切句。</p>
      </div>
    </div>`;
}

function customQuestionsHtml() {
  const questions = customScan.doc?.questions || [];
  if (!questions.length) return '';
  return `<div class="scan-question-list">
      <span class="cf-label">识别到 ${questions.length} 道题，点选导入：</span>
      <div class="scan-q-actions">
        ${questions.map((q, i) => `<button type="button" class="scan-q-btn${i === customScan.qIndex ? ' active' : ''}" data-act="custom-q" data-idx="${i}">第 ${i + 1} 题${q.no ? `（${escapeHtml(q.no)}）` : ''}</button>`).join('')}
      </div>
      <p class="scan-review-note">导入后仍可在下方修改题干、选项与用户提供的参考答案。</p>
    </div>`;
}

function customScanUsage(res) {
  if (!res || res.cached) return res?.cached ? '已复用同一张照片的识别结果' : '';
  const bits = [];
  const ms = Number(res.meta?.durationMs);
  if (Number.isFinite(ms) && ms > 0) bits.push(`${(ms / 1000).toFixed(1)}s`);
  const credits = res.usage?.totalCredits;
  if (Number.isFinite(credits)) bits.push(`${credits} credits`);
  return bits.join(' · ');
}

function applyImportedQuestion(idx, { renderNow = true } = {}) {
  const questions = customScan.doc?.questions || [];
  const q = questions[idx];
  if (!q) return false;
  const form = state.customForm || blankCustomForm();
  form.stem = q.stem;
  form.answer = '';
  form.options = { A: '', B: '', C: '', D: '' };
  for (const opt of q.options) form.options[opt.key] = opt.text;
  customScan.qIndex = idx;
  saveState();
  if (renderNow) render();
  return true;
}

function paintCustomScan() {
  const st = $('lab-scan-status');
  if (!st) return;
  st.hidden = !customScan.text;
  if (customScan.tone) st.dataset.state = customScan.tone;
  else delete st.dataset.state;
  st.textContent = customScan.text;
  const preview = $('lab-scan-preview');
  if (customScan.preview && !customScan.doc) {
    if (preview) {
      const img = $('lab-scan-img');
      if (img) img.src = customScan.preview;
      preview.hidden = false;
    } else {
      $('lab-scan-file')?.closest('.scan-inline')?.insertAdjacentHTML('beforeend', customScanPreviewHtml());
    }
  } else if (preview) {
    preview.remove();
  }
  const retry = labStage.querySelector('[data-act="custom-scan-retry"]');
  if (retry) retry.hidden = !customScan.retry;
  const clear = labStage.querySelector('[data-act="custom-scan-clear"]');
  if (clear) clear.hidden = !customScan.preview;
  const rotate = labStage.querySelector('[data-act="custom-scan-rotate"]');
  if (rotate) rotate.hidden = !customScan.preview;
  labStage.querySelectorAll('[data-act="custom-scan"], [data-act="custom-scan-rotate"], [data-act="custom-scan-retry"], [data-act="custom-scan-clear"]')
    .forEach(b => { b.disabled = customScan.busy; });
}

function setCustomScanStatus(tone, text, retry) {
  customScan.tone = tone || '';
  customScan.text = text || '';
  if (retry !== undefined) customScan.retry = retry;
  paintCustomScan();
}

function resetCustomScan() {
  customScan.busy = false;
  customScan.lastFile = null;
  customScan.controller = null;
  customScan.tone = '';
  customScan.text = '';
  customScan.preview = '';
  customScan.retry = false;
  customScan.rotate = 0;
  customScan.doc = null;
  customScan.qIndex = 0;
}

async function runCustomScan(file, { bypassCache = false } = {}) {
  if (customScan.busy || !isFeatureEnabled('scan')) return;
  customScan.lastFile = file;
  const form = state.customForm || blankCustomForm();
  if (String(form.text || '').trim() && !window.confirm('识别结果会替换当前原文与题目，继续吗？')) return;
  customScan.busy = true;
  customScan.retry = false;
  customScan.controller = new AbortController();
  const timer = setTimeout(() => customScan.controller.abort(), 90000);
  paintCustomScan();
  setCustomScanStatus('loading', '正在压缩照片…');
  try {
    const res = await transcribePhoto(file, {
      target: 'reading',
      level: form.level === 'CET6' ? 'CET6' : 'CET4',
      structured: true,
      rotate: customScan.rotate,
      bypassCache,
      signal: customScan.controller.signal,
      onStatus: (tone, msg) => setCustomScanStatus(tone, msg),
      onPreview: dataUrl => { customScan.preview = dataUrl; paintCustomScan(); },
    });
    const doc = res.doc || {};
    const passage = String(doc.passage || '').trim() || res.text;
    if (passage.length > 12000) throw new Error(`识别到 ${passage.length} 字符，超过 12000 上限，请只拍一页或分段导入。`);
    state.customForm.text = passage;
    customScan.doc = doc;
    customScan.qIndex = 0;
    const questions = Array.isArray(doc.questions) ? doc.questions : [];
    if (questions.length) applyImportedQuestion(0, { renderNow: false });
    saveState();
    const parts = [];
    if (questions.length) parts.push(`已识别并导入 ${questions.length} 道题中的第 1 题`);
    else parts.push('未识别到完整 A/B/C/D 题目，请手动填写题干与选项');
    if (doc.uncertain?.length) parts.push(`${doc.uncertain.length} 处文字不确定，已高亮`);
    const note = res.notes ? `（${res.notes}）` : '';
    const usage = customScanUsage(res);
    if (usage) parts.push(usage);
    const warn = res.confidence === 'low' || !questions.length;
    customScan.tone = warn ? 'warn' : 'done';
    customScan.text = `识别完成，可信度${confidenceLabel(res.confidence)}${note}。${parts.join('；')}。`;
    customScan.retry = false;
    render();
    $('lab-custom-text')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    toast('已导入原文，可先校对');
  } catch (err) {
    if (customScan.controller?.signal.aborted) setCustomScanStatus('error', '识别超时或已取消，可重试或重新拍照。', !!customScan.lastFile);
    else setCustomScanStatus('error', aiErrorMessage(err), !!customScan.lastFile);
  } finally {
    clearTimeout(timer);
    customScan.busy = false;
    customScan.controller = null;
    paintCustomScan();
  }
}

function customHtml() {
  const f = state.customForm || blankCustomForm();
  const scanEnabled = isFeatureEnabled('scan');
  const trainEnabled = isFeatureEnabled('train');
  return `
    ${stageHead('自带材料 · AI 诊断', '粘贴一篇阅读与一道题')}
    ${stepBar(2)}
    <section class="card stage-card">
      <div class="card-body custom-form">
        <div class="cf-row">
          <span class="cf-label">考试级别</span>
          <div class="seg mini" id="lab-custom-level" data-level="${f.level}">
            <span class="thumb"></span>
            <button type="button" data-act="custom-level" data-level="CET4" aria-pressed="${f.level === 'CET4'}">四级</button>
            <button type="button" data-act="custom-level" data-level="CET6" aria-pressed="${f.level === 'CET6'}">六级</button>
          </div>
        </div>
        <label class="cf-label" for="lab-custom-text">阅读原文 <span class="muted">（按句号等自动切句，最多 60 句）</span></label>
        <div class="scan-inline">
          ${scanEnabled ? `<div class="scan-entry">
            <div class="scan-inline-row">
              <button type="button" class="btn btn-sm" data-act="custom-scan"${customScan.busy ? ' disabled' : ''}><svg><use href="#i-camera"/></svg>拍照导入原文与题目</button>
              <button type="button" class="btn btn-sm btn-ghost" data-act="custom-scan-rotate"${customScan.preview ? '' : ' hidden'}>旋转 90°</button>
              <button type="button" class="btn btn-sm btn-ghost" data-act="custom-scan-retry"${customScan.retry ? '' : ' hidden'}>重试识别</button>
              <button type="button" class="btn btn-sm btn-ghost" data-act="custom-scan-clear"${customScan.preview ? '' : ' hidden'}>移除照片</button>
              <span class="scan-inline-hint">拍照、相册、拖拽或 Ctrl+V 粘贴；识别后可校对</span>
            </div>
            <input type="file" id="lab-scan-file" accept="image/jpeg,image/png,image/webp" hidden />
            ${customScanStatusHtml()}
            ${customScanPreviewHtml()}
            ${customScanReviewHtml()}
          </div>` : '<div class="scan-unavailable" role="status"><span>拍照识别暂不可用，可手动输入。</span><button type="button" class="btn btn-sm btn-ghost" data-act="capabilities-retry">重试</button></div>'}
        </div>
        <textarea id="lab-custom-text" data-field="text" maxlength="12000" placeholder="粘贴英文原文，或拍照导入……">${escapeHtml(f.text)}</textarea>
        ${customQuestionsHtml()}
        <label class="cf-label" for="lab-custom-stem">题干</label>
        <input id="lab-custom-stem" data-field="stem" maxlength="500" value="${escapeHtml(f.stem)}" placeholder="例如：What is the main idea of the passage?" />
        <span class="cf-label">四个选项</span>
        ${['A', 'B', 'C', 'D'].map(k => `<div class="cf-opt"><span>${k}</span><input data-field="opt-${k}" maxlength="300" value="${escapeHtml(f.options[k] || '')}" placeholder="选项 ${k}" /></div>`).join('')}
        <label class="cf-label" for="lab-custom-answer">用户提供的参考答案 <span class="muted">（可选；填写后会以此为准核对）</span></label>
        <select id="lab-custom-answer" data-field="answer">
          <option value="" ${!f.answer ? 'selected' : ''}>无参考答案，AI 判断</option>
          ${['A', 'B', 'C', 'D'].map(k => `<option value="${k}" ${f.answer === k ? 'selected' : ''}>${k}</option>`).join('')}
        </select>
        <button type="button" class="btn btn-primary btn-lg" data-act="start-custom" ${trainEnabled ? '' : 'disabled'}>${trainEnabled ? '<svg><use href="#i-target"/></svg>进入作答' : '暂不可用'}</button>
        <p class="submit-note">${trainEnabled ? '自带题会调用 AI；诊断只引用你原文中的句子 ID，找不到的引句不会展示。' : 'AI 暂不可用，请重试。'}</p>
        ${trainEnabled ? '' : '<button type="button" class="btn btn-sm" data-act="capabilities-retry"><svg><use href="#i-refresh"/></svg>重试</button>'}
      </div>
    </section>`;
}

/* ---------------- rendering root ---------------- */
function currentDraft() {
  if (state.screen === 'transfer') return state.transfer?.draft;
  return state.draft;
}

function render() {
  updateLabModeBadge();
  document.querySelectorAll('.preset').forEach(el => {
    el.classList.toggle('active', state.mode === 'preset' && el.dataset.id === state.material?.id);
  });
  if (state.screen === 'pick' || !state.material && state.screen !== 'custom') {
    labEmpty.hidden = false;
    labStage.hidden = true;
    labStage.innerHTML = '';
    return;
  }
  labEmpty.hidden = true;
  labStage.hidden = false;
  let html = '';
  if (state.screen === 'custom') html = customHtml();
  else if (state.screen === 'answer') html = answerHtml();
  else if (state.screen === 'hint') html = hintHtml();
  else if (state.screen === 'result') html = resultHtml(false);
  else if (state.screen === 'transfer') html = transferAnswerHtml();
  else if (state.screen === 'summary') html = summaryHtml();
  labStage.innerHTML = html || '<div class="card empty"><h3>状态已失效</h3><p>请重新选择材料。</p></div>';
}

function setScreen(screen) {
  state.screen = screen;
  state.error = '';
  state.loading = false;
  saveState();
  render();
  if (screen !== 'pick') {
    const el = $('labStage');
    if (el) setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
  }
}

/* ---------------- interactions ---------------- */
function refreshAnswerUI() {
  const d = currentDraft();
  if (!d) return;
  labStage.querySelectorAll('.opt-btn').forEach(b => {
    const on = b.dataset.key === d.choice;
    b.classList.toggle('sel', on);
    b.setAttribute('aria-pressed', String(on));
  });
  labStage.querySelectorAll('.conf-btn').forEach(b => {
    const on = b.dataset.conf === d.confidence;
    b.classList.toggle('sel', on);
    b.setAttribute('aria-pressed', String(on));
  });
  labStage.querySelectorAll('.sent[data-act="sent"]').forEach(b => {
    const on = d.evidence.includes(b.dataset.sid);
    b.classList.toggle('sel', on);
    b.setAttribute('aria-pressed', String(on));
  });
  const count = labStage.querySelector('.ep-count');
  if (count) count.textContent = `已选 ${d.evidence.length} 句依据`;
}

function toggleEvidence(id) {
  const d = currentDraft();
  if (!d) return;
  const i = d.evidence.indexOf(id);
  if (i >= 0) d.evidence.splice(i, 1);
  else {
    if (d.evidence.length >= 3) { toast('最多选 3 句依据', 'err'); return; }
    d.evidence.push(id);
  }
  saveState();
  refreshAnswerUI();
}

function pickOption(key) {
  const d = currentDraft();
  if (!d) return;
  d.choice = key;
  saveState();
  refreshAnswerUI();
}

function pickConfidence(conf) {
  const d = currentDraft();
  if (!d) return;
  d.confidence = conf;
  saveState();
  refreshAnswerUI();
}

function resetDraft() {
  state.draft = { choice: '', evidence: [], confidence: 'medium' };
}

function startPreset(preset) {
  state.mode = 'preset';
  state.material = normalizePreset(preset);
  resetDraft();
  state.attempt = null;
  state.reanswer = null;
  state.pendingDiagnosis = null;
  state.diagnosis = null;
  state.awaiting = false;
  state.transfer = null;
  setScreen('answer');
}

function blankCustomForm() {
  return { level: 'CET4', text: '', stem: '', options: { A: '', B: '', C: '', D: '' }, answer: '' };
}

function openCustom() {
  if (!state.customForm) state.customForm = blankCustomForm();
  resetCustomScan();
  state.mode = 'custom';
  state.material = null;
  state.attempt = null;
  state.reanswer = null;
  state.pendingDiagnosis = null;
  state.diagnosis = null;
  state.awaiting = false;
  state.transfer = null;
  resetDraft();
  setScreen('custom');
}

function splitSentences(text) {
  const paras = text.replace(/\r\n?/g, '\n').split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  const out = [];
  let n = 0;
  const pushPiece = (piece, para) => {
    let t = piece.trim();
    while (t.length > 600) {
      out.push({ id: `s${++n}`, para, text: t.slice(0, 600) });
      t = t.slice(600).trim();
    }
    if (t) out.push({ id: `s${++n}`, para, text: t });
  };
  const breakLong = (sentence, para) => {
    if (sentence.length <= 520) { pushPiece(sentence, para); return; }
    const parts = sentence.split(/(?<=[,;:])\s+/);
    let cur = '';
    for (const p of parts) {
      const next = cur ? `${cur} ${p}` : p;
      if (next.length > 520) { pushPiece(cur, para); cur = p; }
      else cur = next;
    }
    pushPiece(cur, para);
  };
  (paras.length ? paras : [text]).forEach((p, idx) => {
    for (const sentence of p.split(/(?<=[.!?])\s+/)) {
      if (sentence && sentence.trim()) breakLong(sentence, idx + 1);
    }
  });
  return out;
}

function startCustom() {
  if (!isFeatureEnabled('train')) { toast('暂不可用，请重试。', 'err'); render(); return; }
  const f = state.customForm || blankCustomForm();
  const text = String(f.text || '').trim();
  const stem = String(f.stem || '').trim();
  const options = ['A', 'B', 'C', 'D'].map(key => ({ key, text: String(f.options?.[key] || '').trim() }));
  if (text.length < 20) { toast('请先把阅读原文粘贴完整（至少 20 个字符）', 'err'); return; }
  if (text.length > 12000) { toast('原文过长，请控制在 12000 字符以内', 'err'); return; }
  if (stem.length < 5) { toast('请填写完整的题干（至少 5 个字符）', 'err'); return; }
  if (options.some(o => !o.text)) { toast('请填写 A/B/C/D 四个选项', 'err'); return; }
  const sentences = splitSentences(text);
  if (!sentences.length) { toast('未能切分出句子，请检查原文', 'err'); return; }
  if (sentences.length > 60) { toast('原文句子过多，请精简到 60 句以内', 'err'); return; }
  const referenceAnswer = ['A', 'B', 'C', 'D'].includes(f.answer) ? f.answer : '';
  state.mode = 'custom';
  state.material = normalizeCustomMaterial({
    level: f.level === 'CET6' ? 'CET6' : 'CET4',
    sentences,
    question: { stem, options },
    referenceAnswer,
  });
  resetDraft();
  state.attempt = null;
  state.reanswer = null;
  state.pendingDiagnosis = null;
  state.diagnosis = null;
  state.awaiting = false;
  state.transfer = null;
  setScreen('answer');
}

function validateAttempt(draft) {
  if (!draft.choice) { toast('请先选择一个答案', 'err'); return false; }
  if (!draft.evidence.length) { toast('请点选至少一句原文句子作为依据', 'err'); return false; }
  return true;
}

async function submitCustomTrain() {
  if (!isFeatureEnabled('train')) { state.error = '暂不可用，请重试。'; render(); return; }
  const m = state.material;
  const attempt = state.attempt;
  state.loading = true;
  state.loadingMsg = '正在核对你的选项与依据…';
  state.error = '';
  render();
  try {
    await requireFeature('train');
    const res = await fetch('/functions/v1/app?action=train', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        level: m.level,
        material: {
          sentences: m.sentences.map(s => ({ id: s.id, text: s.text })),
          question: { stem: m.question.stem, options: m.question.options },
        },
        attempt: {
          choice: attempt.choice,
          evidence: attempt.evidence,
          confidence: attempt.confidence,
          referenceAnswer: m.referenceAnswer || '',
        },
      }),
    });
    if (!res.ok) {
      let msg = '暂不可用，请重试。';
      let code = '';
      try { const j = await res.json(); if (j?.message) msg = j.message; if (j?.error) code = j.error; } catch {}
      const error = new Error(aiErrorMessage({ code }, msg));
      error.code = code;
      throw error;
    }
    let result = null;
    let failed = '';
    await consumeSSE(res, frame => {
      let env;
      try { env = JSON.parse(frame.data); } catch { return false; }
      if (env.type === 'status') { if (env.message) state.loadingMsg = env.message; return false; }
      if (env.type === 'result') { result = env; return false; }
      if (env.type === 'done') return true;
      if (env.type === 'error') { failed = aiErrorMessage({ code: env.code }, env.message); return true; }
      return false;
    });
    if (failed) throw new Error(failed);
    if (!result) throw new Error('AI 未返回诊断结果，请重试。');
    const normalized = normalizeDiagnosis(result, m, attempt);
    if (!normalized) throw new Error('AI 未给出可核对的正确项，请重试。');
    const requestId = res.headers.get('x-request-id');
    if (isCloudRequestId(requestId)) normalized.requestId = requestId;
    state.pendingDiagnosis = normalized;
    state.loading = false;
    setScreen('hint');
  } catch (err) {
    state.loading = false;
    state.error = aiErrorMessage(err);
    saveState();
    render();
  }
}

function submitAnswer() {
  if (state.loading) return;
  if (state.mode === 'custom' && !isFeatureEnabled('train')) { toast('暂不可用，请重试。', 'err'); return; }
  if (state.awaiting) {
    const draft = { ...state.draft, evidence: state.draft.evidence.slice() };
    if (!validateAttempt(draft)) return;
    state.reanswer = draft;
    if (!state.pendingDiagnosis) { toast('短提示尚未准备好，请重试', 'err'); return; }
    state.diagnosis = state.pendingDiagnosis;
    state.awaiting = false;
    setScreen('result');
    return;
  }
  const draft = { ...state.draft, evidence: state.draft.evidence.slice() };
  if (!validateAttempt(draft)) return;
  state.attempt = draft;
  if (state.mode === 'preset') {
    state.pendingDiagnosis = diagnoseVerified(state.material, draft);
    saveState();
    setScreen('hint');
  } else {
    submitCustomTrain();
  }
}

function startReanswer() {
  if (!state.attempt) return;
  state.awaiting = true;
  state.draft = { choice: '', evidence: state.attempt.evidence.slice(), confidence: state.attempt.confidence };
  setScreen('answer');
}

function revealDiagnosis() {
  if (!state.pendingDiagnosis) return;
  state.diagnosis = state.pendingDiagnosis;
  state.reanswer = null;
  setScreen('result');
}

async function loadTransfer() {
  const errorType = state.diagnosis?.error_type;
  const wanted = ['scope_expansion', 'causal_inversion', 'attitude_shift'].includes(errorType) ? errorType : 'scope_expansion';
  const base = {
    item: null,
    draft: { choice: '', evidence: [], confidence: 'medium' },
    attempt: null,
    diagnosis: null,
    loading: false,
    error: '',
  };
  if (state.mode === 'preset') {
    const item = state.material?.transfer || null;
    state.transfer = { ...base, item, error: item ? '' : '本篇没有内置同类题，请换一篇。' };
    setScreen('transfer');
    return;
  }
  if (!isFeatureEnabled('train')) {
    state.transfer = { ...base, error: '暂不可用，请重试。' };
    setScreen('transfer');
    return;
  }
  state.transfer = { ...base, loading: true };
  setScreen('transfer');
  try {
    const res = await fetch('/functions/v1/app?action=transfer', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ errorType: wanted, seed: Date.now() }),
    });
    const j = await res.json().catch(() => null);
    if (!res.ok || !j?.ok || !j.item) throw new Error(aiErrorMessage({ code: j?.error }, j?.message));
    state.transfer.item = normalizeTransfer(j.item, wanted, 'ai');
    state.transfer.loading = false;
    saveState();
    render();
  } catch (err) {
    state.transfer.loading = false;
    state.transfer.error = aiErrorMessage(err, '同类题加载失败，请重试。');
    render();
  }
}

function submitTransfer() {
  const tr = state.transfer;
  if (!tr || !tr.item || tr.diagnosis) return;
  const draft = { ...tr.draft, evidence: tr.draft.evidence.slice() };
  if (!validateAttempt(draft)) return;
  tr.attempt = draft;
  tr.diagnosis = diagnoseVerified(tr.item, draft);
  saveState();
  render();
}

function scrollToSentence(id) {
  const el = labStage.querySelector(`[data-sid="${CSS.escape(id)}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1400);
}

function restartSame() {
  if (!state.material) { goPick(); return; }
  resetDraft();
  state.attempt = null;
  state.reanswer = null;
  state.pendingDiagnosis = null;
  state.diagnosis = null;
  state.awaiting = false;
  state.transfer = null;
  setScreen('answer');
}

function goPick() {
  state.screen = 'pick';
  state.mode = 'preset';
  state.material = null;
  state.transfer = null;
  state.attempt = null;
  state.reanswer = null;
  state.pendingDiagnosis = null;
  state.diagnosis = null;
  state.awaiting = false;
  resetDraft();
  state.error = '';
  state.loading = false;
  saveState();
  render();
}

function reselectEvidence() {
  state.attempt = null;
  state.pendingDiagnosis = null;
  state.diagnosis = null;
  state.reanswer = null;
  state.awaiting = false;
  resetDraft();
  setScreen('answer');
}

/* ---------------- wiring ---------------- */
function updateLabModeBadge() {
  const el = $('labModeBadge');
  if (!el) return;
  if (state.mode === 'custom') {
    const enabled = isFeatureEnabled('train');
    el.textContent = enabled ? '自带题 · AI 诊断可用' : '自带题 · AI 诊断暂不可用';
    el.dataset.mode = enabled ? 'live' : 'down';
  } else {
    el.textContent = '预置练习 · 原创题 · 原文核对';
    el.dataset.mode = 'preset';
  }
}

function renderPresetList() {
  $('labItemCount').textContent = `${LAB_ITEM_COUNT} 道原创练习`;
  $('labItemBreakdown').textContent = `${LAB_PRESETS.length} 道主练习 · ${LAB_ITEM_COUNT - LAB_PRESETS.length} 道同类题`;
  $('labPresetList').innerHTML = LAB_PRESETS.map(p => `
    <button type="button" class="preset" data-id="${p.id}">
      <span class="preset-top"><span class="preset-tag">${escapeHtml(p.tag)}</span><span class="preset-lv">${p.level === 'CET6' ? '六级' : '四级'}</span></span>
      <b>${escapeHtml(p.title)}</b>
      <span class="preset-blurb">${escapeHtml(p.blurb)}</span>
    </button>`).join('');
}

$('labPresetList').addEventListener('click', e => {
  const btn = e.target.closest('.preset');
  if (!btn) return;
  const preset = findPreset(btn.dataset.id);
  if (preset) startPreset(preset);
});

$('labStartBtn').addEventListener('click', () => { if (LAB_PRESETS[0]) startPreset(LAB_PRESETS[0]); });
$('labEmptyStart').addEventListener('click', () => { if (LAB_PRESETS[0]) startPreset(LAB_PRESETS[0]); });
$('labCustomBtn').addEventListener('click', openCustom);
$('labSideCustomBtn').addEventListener('click', openCustom);

labStage.addEventListener('click', e => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  if (act === 'sent') { toggleEvidence(btn.dataset.sid); return; }
  if (act === 'opt') { pickOption(btn.dataset.key); return; }
  if (act === 'conf') { pickConfidence(btn.dataset.conf); return; }
  if (act === 'jump') { scrollToSentence(btn.dataset.id); return; }
  if (act === 'submit') { submitAnswer(); return; }
  if (act === 'retry-train') { if (state.attempt) submitCustomTrain(); return; }
  if (act === 'reanswer') { startReanswer(); return; }
  if (act === 'reveal') { revealDiagnosis(); return; }
  if (act === 'reselect') { reselectEvidence(); return; }
  if (act === 'transfer') { loadTransfer(); return; }
  if (act === 'retry-transfer') { loadTransfer(); return; }
  if (act === 'submit-transfer') { submitTransfer(); return; }
  if (act === 'summary') { setScreen('summary'); return; }
  if (act === 'restart') { restartSame(); return; }
  if (act === 'pick') { goPick(); return; }
  if (act === 'start-custom') { startCustom(); return; }
  if (act === 'custom-level') { state.customForm.level = btn.dataset.level === 'CET6' ? 'CET6' : 'CET4'; saveState(); render(); return; }
  if (act === 'capabilities-retry') { void refreshCapabilities(); return; }
  if (act === 'custom-scan') { if (isFeatureEnabled('scan')) $('lab-scan-file')?.click(); return; }
  if (act === 'custom-scan-rotate') {
    if (customScan.busy || !customScan.lastFile) return;
    customScan.rotate = (customScan.rotate + 90) % 360;
    runCustomScan(customScan.lastFile, { bypassCache: true });
    return;
  }
  if (act === 'custom-scan-retry') { if (customScan.lastFile) runCustomScan(customScan.lastFile, { bypassCache: true }); return; }
  if (act === 'custom-q') { applyImportedQuestion(Number(btn.dataset.idx)); return; }
  if (act === 'custom-scan-clear') {
    if (customScan.busy) return;
    customScan.preview = ''; customScan.tone = ''; customScan.text = ''; customScan.retry = false;
    customScan.doc = null; customScan.qIndex = 0; customScan.rotate = 0;
    paintCustomScan();
    render();
    return;
  }
});

labStage.addEventListener('input', e => {
  const field = e.target.closest('[data-field]');
  if (!field) return;
  const key = field.dataset.field;
  if (!state.customForm) state.customForm = blankCustomForm();
  if (key === 'text') state.customForm.text = field.value;
  else if (key === 'stem') state.customForm.stem = field.value;
  else if (key === 'answer') state.customForm.answer = field.value;
  else if (key.startsWith('opt-')) state.customForm.options[key.slice(4)] = field.value;
  scheduleSave();
});

labStage.addEventListener('change', e => {
  if (e.target.id !== 'lab-scan-file') return;
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  const err = photoFileError(file);
  if (err) { toast(err, 'err'); return; }
  customScan.rotate = 0;
  runCustomScan(file);
});

wirePhotoDropPaste(labStage, file => {
  if (state.screen !== 'custom' || customScan.busy) return;
  const err = photoFileError(file);
  if (err) { toast(err, 'err'); return; }
  customScan.rotate = 0;
  runCustomScan(file);
}, { onError: msg => toast(msg, 'err'), enabled: () => state.screen === 'custom' && isFeatureEnabled('scan') });

/* ---------------- sub-panel nav ---------------- */
function showPanel(which, persist = true) {
  const lab = which !== 'tool';
  $('labPanel').hidden = !lab;
  $('toolPanel').hidden = lab;
  $('subtab-lab').setAttribute('aria-selected', String(lab));
  $('subtab-tool').setAttribute('aria-selected', String(!lab));
  if (persist) { try { localStorage.setItem('cet.reading.panel', lab ? 'lab' : 'tool'); } catch { /* ignore */ } }
}
$('subtab-lab').addEventListener('click', () => showPanel('lab'));
$('subtab-tool').addEventListener('click', () => showPanel('tool'));

/* ---------------- init ---------------- */
const countNode = document.getElementById('labItemCount');
const breakdownNode = document.getElementById('labItemBreakdown');
if (countNode) countNode.textContent = `${LAB_ITEM_COUNT} 道`;
if (breakdownNode) breakdownNode.textContent = `${LAB_PRESETS.length} 主题 + ${LAB_PRESETS.length} 同类`;
renderPresetList();
const restored = restoreState();
if (restored) render(); else { state.screen = 'pick'; render(); }
updateLabModeBadge();
onCapabilities(() => { updateLabModeBadge(); if (state.screen === 'custom' || state.screen === 'answer') render(); });

let savedPanel = 'lab';
try { const p = localStorage.getItem('cet.reading.panel'); if (p === 'tool') savedPanel = 'tool'; } catch { /* ignore */ }
showPanel(savedPanel, false);

// expose a tiny hook for local UI checks / tests without affecting production
export const __labState = state;
