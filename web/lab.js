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
import { LAB_PRESETS, ERROR_LABELS, findPreset } from './lab-data.js';
import { escapeHtml } from './markdown.js';
import { consumeSSE } from './sse.mjs';
import { toast, getServiceMode } from './shell.js';

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

/* ---------------- data shaping ---------------- */
function normalizeTransfer(source, errorType) {
  return {
    id: source.id,
    title: source.title,
    level: source.level || 'CET4',
    tag: source.tag || ERROR_LABELS[errorType] || '同类题',
    sentences: source.passage || source.sentences,
    question: source.question,
    evidence: source.evidence,
    traps: source.traps || {},
    correctNote: source.correctNote || '',
    sourceLabel: '预置同类题 · 人工核对',
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
    sourceLabel: '预置练习 · 人工核对',
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
    tag: '真实 AI 诊断',
    sentences: raw.sentences,
    question: { stem: raw.question.stem, options, answer: '' },
    evidence: [],
    traps: {},
    correctNote: '',
    transfer: null,
    referenceAnswer: raw.referenceAnswer || '',
    sourceLabel: '自带材料 · 真实 AI 诊断',
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
  state.pendingDiagnosis = saved.pendingDiagnosis || null;
  state.diagnosis = saved.diagnosis || null;
  state.awaiting = Boolean(saved.awaiting);
  if (saved.transfer && saved.transfer.item) {
    state.transfer = {
      item: saved.transfer.item,
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
  const modeLabel = m.mode === 'preset' ? m.sourceLabel : `${m.sourceLabel}${getServiceMode() === 'live' ? '' : '（当前为本地假 AI）'}`;
  return `
    ${stageHead(modeLabel, m.title)}
    ${stepBar(reanswer ? 4 : 2)}
    ${state.error ? `<div class="lab-error" role="alert"><b>诊断失败</b><p>${escapeHtml(state.error)}</p><button type="button" class="btn btn-sm" data-act="retry-train"><svg><use href="#i-refresh"/></svg>重试诊断</button></div>` : ''}
    ${state.loading ? `<div class="lab-loading"><span class="spin"></span>${escapeHtml(state.loadingMsg || '正在调用真实 AI 核对你的选项与依据…')}</div>` : ''}
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
        <button type="button" class="btn btn-primary btn-lg" data-act="submit" ${state.loading ? 'disabled' : ''}>
          <svg><use href="#i-spark"/></svg>${state.loading ? '正在诊断…' : reanswer ? '提交重答并查看结果' : '提交并查看短提示'}
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
    <div class="v-meta">信心 ${CONF_LABEL[attempt.confidence] || '—'} · ${alignmentLabel(diagnosis)} · 错因诊断基于首答</div>
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
    ${stageHead(isTransfer ? '同类新材料 · 用预置/核过题目验证' : material.sourceLabel, isTransfer ? state.transfer.item.title : material.title)}
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
  if (fixed && tr?.answer_correct) return '本次你先错后改对，并在同类新题上迁移成功；继续坚持“先找依据再选”。';
  if (fixed) return '本次重答已修正，但同类题仍有偏差；回到原文逐句核对数量、因果和态度词。';
  return '本次首答与重答仍有偏差；建议先看证据卡里的英文差异，再重做同类题。';
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
    <div class="advice-card"><span class="tag t">下一步</span><p>${escapeHtml(advice)}</p></div>
    <div class="stage-actions">
      <button type="button" class="btn btn-primary" data-act="pick"><svg><use href="#i-book"/></svg>再练一篇</button>
      <button type="button" class="btn" data-act="restart">重做本篇</button>
    </div>`;
}

function customHtml() {
  const f = state.customForm || blankCustomForm();
  return `
    ${stageHead('自带材料 · 真实 AI 诊断', '粘贴一篇阅读与一道题')}
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
        <textarea id="lab-custom-text" data-field="text" maxlength="12000" placeholder="粘贴英文原文……">${escapeHtml(f.text)}</textarea>
        <label class="cf-label" for="lab-custom-stem">题干</label>
        <input id="lab-custom-stem" data-field="stem" maxlength="500" value="${escapeHtml(f.stem)}" placeholder="例如：What is the main idea of the passage?" />
        <span class="cf-label">四个选项</span>
        ${['A', 'B', 'C', 'D'].map(k => `<div class="cf-opt"><span>${k}</span><input data-field="opt-${k}" maxlength="300" value="${escapeHtml(f.options[k] || '')}" placeholder="选项 ${k}" /></div>`).join('')}
        <label class="cf-label" for="lab-custom-answer">参考答案 <span class="muted">（可选；填写后会以此为准核对）</span></label>
        <select id="lab-custom-answer" data-field="answer">
          <option value="" ${!f.answer ? 'selected' : ''}>不确定，让 AI 判断</option>
          ${['A', 'B', 'C', 'D'].map(k => `<option value="${k}" ${f.answer === k ? 'selected' : ''}>${k}</option>`).join('')}
        </select>
        <button type="button" class="btn btn-primary btn-lg" data-act="start-custom"><svg><use href="#i-target"/></svg>进入作答</button>
        <p class="submit-note">自带题会调用真实 AI；诊断只引用你原文中的句子 ID，找不到的引句不会展示。</p>
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
  const m = state.material;
  const attempt = state.attempt;
  state.loading = true;
  state.loadingMsg = '正在调用真实 AI 核对你的选项与依据…';
  state.error = '';
  render();
  try {
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
      let msg = '诊断请求失败，请稍后重试。';
      try { const j = await res.json(); if (j?.message) msg = j.message; } catch { /* ignore */ }
      throw new Error(msg);
    }
    let result = null;
    let failed = '';
    await consumeSSE(res, frame => {
      let env;
      try { env = JSON.parse(frame.data); } catch { return false; }
      if (env.type === 'status') { if (env.message) state.loadingMsg = env.message; return false; }
      if (env.type === 'result') { result = env; return false; }
      if (env.type === 'done') return true;
      if (env.type === 'error') { failed = env.message || 'AI 诊断失败'; return true; }
      return false;
    });
    if (failed) throw new Error(failed);
    if (!result) throw new Error('AI 未返回诊断结果，请重试。');
    const normalized = normalizeDiagnosis(result, m, attempt);
    if (!normalized) throw new Error('AI 未给出可核对的正确项，请重试。');
    state.pendingDiagnosis = normalized;
    state.loading = false;
    setScreen('hint');
  } catch (err) {
    state.loading = false;
    state.error = err.message || '诊断失败，请重试。';
    saveState();
    render();
  }
}

function submitAnswer() {
  if (state.loading) return;
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
    if (!res.ok || !j?.ok || !j.item) throw new Error(j?.message || '同类题加载失败');
    state.transfer.item = normalizeTransfer(j.item, wanted);
    state.transfer.loading = false;
    saveState();
    render();
  } catch (err) {
    state.transfer.loading = false;
    state.transfer.error = err.message || '同类题加载失败';
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
    const mode = getServiceMode();
    if (mode === 'live') { el.textContent = '自带题 · 真实 AI（Qoder Cloud Agents）'; el.dataset.mode = 'live'; }
    else if (mode === 'down') { el.textContent = '自带题 · 服务离线'; el.dataset.mode = 'down'; }
    else { el.textContent = '自带题 · 真实 AI 路径（本地为假 AI 夹具）'; el.dataset.mode = 'local'; }
  } else {
    el.textContent = '预置练习 · 人工核对（不调用 AI）';
    el.dataset.mode = 'preset';
  }
}

function renderPresetList() {
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
renderPresetList();
const restored = restoreState();
if (restored) render(); else { state.screen = 'pick'; render(); }
updateLabModeBadge();
setTimeout(updateLabModeBadge, 1500);

let savedPanel = 'lab';
try { const p = localStorage.getItem('cet.reading.panel'); if (p === 'tool') savedPanel = 'tool'; } catch { /* ignore */ }
showPanel(savedPanel, false);

// expose a tiny hook for local UI checks / tests without affecting production
export const __labState = state;
