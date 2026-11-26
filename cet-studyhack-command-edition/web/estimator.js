import { WEIGHTS, BANDS, computeEstimate } from './engine.js';
import { consumeSSE } from './sse.mjs';
import { renderMarkdown } from './markdown.js';
import { aiErrorMessage, getCapabilities, isFeatureEnabled, onCapabilities, refreshCapabilities, requireFeature, toast } from './shell.js';
import { photoFileError, transcribePhoto, confidenceLabel, highlightUncertain, wirePhotoDropPaste } from './scan.js';

// All estimator element IDs are prefixed `est-` so they never collide with the
// reading lab's IDs in the combined page. Results are framed as reference
// intervals and a gap to the 425 reference target — never a pass probability or
// an official-score claim.
const $ = id => document.getElementById(`est-${id}`);
const root = () => document.getElementById('view-estimator');
const API = '/functions/v1/app';
const MODULE_NAME = { listening: '听力', reading: '阅读', writing: '写作', translation: '翻译' };
const BAND_NAME = { low: '低档', mid: '中档', high: '高档' };

const state = {
  level: 'CET4',
  listening: {},
  reading: {},
  writing: { mode: 'band', band: 'mid', text: '', prompt: '' },
  translation: { mode: 'band', band: 'mid', text: '', source: '' },
};
let estimate = null;
let aiComments = null;
let aiMeta = null;
let gradeState = 'idle';
let gradeMessage = '';
let gradeRequested = { writing: false, translation: false };
let moduleSources = { listening: '用户自报', reading: '用户自报', writing: '按自评估算', translation: '按自评估算' };
let busy = false;
let gradeAbort = null;
let recAbort = null;
let recRaw = '';
let recRunning = false;
let recState = 'idle';
let timerId = null;
let startedAt = 0;

const SCAN_UI = {
  writing: { name: '作文', field: 'writingText' },
  translation: { name: '翻译', field: 'translationText' },
};
const scanners = {};

/* ---------------- photo transcription (writing / translation) ---------------- */
function scanEl(mod, name) { return $(`${mod}Scan${name}`); }

function updateScanAvailability(mod) {
  const enabled = isFeatureEnabled('scan');
  const box = scanEl(mod, 'Btn').closest('.scan-inline');
  box.querySelector('.scan-entry').hidden = !enabled;
  scanEl(mod, 'Unavailable').hidden = enabled;
  scanEl(mod, 'CapabilityRetry').hidden = enabled || getCapabilities().status !== 'unknown';
}

function updateCapabilityUI() {
  for (const mod of ['writing', 'translation']) updateScanAvailability(mod);
  $('recommendBtn').title = isFeatureEnabled('recommend') ? '' : '暂不可用，请重试。';
}

function setScanStatus(mod, tone, text) {
  const el = scanEl(mod, 'Status');
  el.hidden = !text;
  if (tone) el.dataset.state = tone;
  else delete el.dataset.state;
  el.textContent = text || '';
}

function setScanBusyUI(mod, on) {
  for (const name of ['Btn', 'Rotate', 'Retry', 'Clear']) scanEl(mod, name).disabled = on;
}

function showScanPhoto(mod, dataUrl) {
  scanEl(mod, 'ReviewImg').src = dataUrl;
  scanEl(mod, 'Review').hidden = false;
  scanEl(mod, 'Clear').hidden = false;
  scanEl(mod, 'Rotate').hidden = false;
}

function scanUsageText(res) {
  if (res.cached) return '已复用同一张照片的识别结果，本次未重复调用模型。';
  const bits = [];
  const ms = Number(res.meta?.durationMs);
  if (Number.isFinite(ms) && ms > 0) bits.push(`耗时 ${(ms / 1000).toFixed(1)} 秒`);
  const credits = res.usage?.totalCredits;
  if (Number.isFinite(credits)) bits.push(`本次 ${credits} credits`);
  if (res.meta?.model) bits.push(`模型 ${res.meta.model}`);
  return bits.length ? `服务端实测：${bits.join(' · ')}` : '服务端未返回本次用量数据。';
}

function renderScanReview(mod, res) {
  const doc = res.doc || {};
  const materialName = mod === 'writing' ? '作文题目' : '中文原文';
  const answerName = mod === 'writing' ? '学生作文' : '学生译文';
  const uncertain = doc.uncertain || [];
  const blocks = [];
  if (doc.prompt_material) {
    blocks.push(`<div class="scan-review-block"><h4>${materialName}（自动识别）</h4><div>${highlightUncertain(doc.prompt_material, uncertain)}</div></div>`);
  }
  if (doc.student_answer) {
    blocks.push(`<div class="scan-review-block"><h4>${answerName}（保留原始拼写与错误）</h4><div>${highlightUncertain(doc.student_answer, uncertain)}</div></div>`);
  }
  if (!blocks.length) {
    blocks.push(`<div class="scan-review-block"><h4>整页识别文本</h4><div>${highlightUncertain(res.text, uncertain)}</div></div>`);
  }
  blocks.push('<p class="scan-review-note">黄色标记为识别不确定处。请在下方文本框直接校对；确认后再估分。</p>');
  scanEl(mod, 'ReviewText').innerHTML = blocks.join('');
  const usage = scanEl(mod, 'Usage');
  usage.hidden = false;
  usage.textContent = scanUsageText(res);
}

function clearScanPhoto(mod) {
  const s = scanners[mod];
  if (!s) return;
  s.lastFile = null;
  s.rotate = 0;
  scanEl(mod, 'ReviewImg').removeAttribute('src');
  scanEl(mod, 'Review').hidden = true;
  scanEl(mod, 'ReviewText').innerHTML = '';
  scanEl(mod, 'Usage').hidden = true;
  scanEl(mod, 'Clear').hidden = true;
  scanEl(mod, 'Rotate').hidden = true;
  scanEl(mod, 'Retry').hidden = true;
  scanEl(mod, 'File').value = '';
  setScanStatus(mod, '', '');
}

function fillFromScan(mod, res) {
  const { field } = SCAN_UI[mod];
  const textarea = $(field);
  const materialEl = mod === 'writing' ? $('writingPrompt') : $('translationSource');
  const doc = res.doc || {};
  const answer = String(doc.student_answer || '').trim();
  const material = String(doc.prompt_material || '').trim();
  const warnings = [];
  if (doc.kind && doc.kind !== 'other' && doc.kind !== mod) {
    warnings.push(`照片更像${doc.kind === 'reading' ? '阅读题' : doc.kind === 'writing' ? '作文' : '翻译'}，请核对题型`);
  }
  if (answer) textarea.value = answer;
  else {
    textarea.value = res.text;
    warnings.push('未区分出学生作答，整页文本已放入文本框，请手动拆出题目');
  }
  if (material) materialEl.value = material;
  if (!material) warnings.push(mod === 'writing'
    ? '未识别到作文题目，本次只给语言反馈'
    : '未识别到中文原文，本次不判断信息覆盖');
  state[mod].mode = 'ai';
  applyModUI(mod);
  saveForm();
  renderScanReview(mod, res);
  return warnings;
}

async function runScan(mod, file, { bypassCache = false } = {}) {
  const s = scanners[mod];
  if (!s || s.busy || !isFeatureEnabled('scan')) return;
  s.lastFile = file;
  const { name, field } = SCAN_UI[mod];
  const textarea = $(field);
  const materialEl = mod === 'writing' ? $('writingPrompt') : $('translationSource');
  if ((textarea.value.trim() || materialEl.value.trim())
    && !window.confirm(`识别结果会覆盖当前${name}文本，继续吗？`)) return;
  s.busy = true;
  s.controller = new AbortController();
  const timer = setTimeout(() => s.controller.abort(), 90000);
  setScanBusyUI(mod, true);
  scanEl(mod, 'Retry').hidden = true;
  setScanStatus(mod, 'loading', '正在压缩照片…');
  try {
    const res = await transcribePhoto(file, {
      target: mod,
      level: state.level,
      structured: true,
      rotate: s.rotate,
      bypassCache,
      signal: s.controller.signal,
      onStatus: (tone, msg) => setScanStatus(mod, tone, msg),
      onPreview: dataUrl => showScanPhoto(mod, dataUrl),
    });
    const warnings = fillFromScan(mod, res);
    const note = res.notes ? `（${res.notes}）` : '';
    const warn = res.confidence === 'low' || warnings.length;
    setScanStatus(mod, warn ? 'warn' : 'done',
      `识别完成，可信度${confidenceLabel(res.confidence)}${note}。${warnings.length ? warnings.join('；') + '。' : '已拆分题目与作答并填入下方，请核对后再估分。'}`);
    textarea.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (window.innerWidth > 920) textarea.focus({ preventScroll: true });
  } catch (err) {
    if (s.controller?.signal.aborted) setScanStatus(mod, 'error', '识别超时或已取消，可重试或重新拍照。');
    else setScanStatus(mod, 'error', aiErrorMessage(err));
    scanEl(mod, 'Retry').hidden = !s.lastFile;
  } finally {
    clearTimeout(timer);
    s.busy = false;
    s.controller = null;
    setScanBusyUI(mod, false);
  }
}

function wireScanner(mod) {
  scanners[mod] = { busy: false, lastFile: null, controller: null, rotate: 0 };
  scanEl(mod, 'Btn').addEventListener('click', () => { if (isFeatureEnabled('scan')) scanEl(mod, 'File').click(); });
  scanEl(mod, 'CapabilityRetry').addEventListener('click', () => { void refreshCapabilities(); });
  scanEl(mod, 'File').addEventListener('change', e => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const err = photoFileError(file);
    if (err) { toast(err, 'err'); return; }
    scanners[mod].rotate = 0;
    runScan(mod, file);
  });
  scanEl(mod, 'Rotate').addEventListener('click', () => {
    const s = scanners[mod];
    if (!s.lastFile || s.busy) return;
    s.rotate = (s.rotate + 90) % 360;
    runScan(mod, s.lastFile, { bypassCache: true });
  });
  scanEl(mod, 'Retry').addEventListener('click', () => {
    const file = scanners[mod].lastFile;
    if (file) runScan(mod, file, { bypassCache: true });
  });
  scanEl(mod, 'Clear').addEventListener('click', () => {
    if (!scanners[mod].busy) clearScanPhoto(mod);
  });
  wirePhotoDropPaste(document.querySelector(`.ai-box[data-target="${mod}"]`), file => {
    const err = photoFileError(file);
    if (err) { toast(err, 'err'); return; }
    scanners[mod].rotate = 0;
    runScan(mod, file);
  }, { onError: msg => toast(msg, 'err'), enabled: () => isFeatureEnabled('scan') });
}

/* ---------------- helpers ---------------- */
function clampInt(v, lo, hi) { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo; }

function saveForm() {
  try {
    state.writing.text = $('writingText').value;
    state.writing.prompt = $('writingPrompt').value;
    state.translation.text = $('translationText').value;
    state.translation.source = $('translationSource').value;
    localStorage.setItem('cet-score.form', JSON.stringify(state));
  } catch { /* storage full */ }
}
function loadForm() {
  try {
    const raw = localStorage.getItem('cet-score.form');
    if (!raw) return;
    const s = JSON.parse(raw);
    if (s.level === 'CET6' || s.level === 'CET4') state.level = s.level;
    if (s.listening) state.listening = s.listening;
    if (s.reading) state.reading = s.reading;
    for (const k of ['writing', 'translation']) {
      if (s[k]) {
        state[k].mode = s[k].mode === 'ai' ? 'ai' : 'band';
        state[k].band = BANDS[s[k].band] ? s[k].band : 'mid';
        state[k].text = typeof s[k].text === 'string' ? s[k].text : '';
        const material = k === 'writing' ? s[k].prompt : s[k].source;
        state[k][k === 'writing' ? 'prompt' : 'source'] = typeof material === 'string' ? material : '';
      }
    }
  } catch { /* corrupt draft */ }
}

function startTimer() {
  startedAt = performance.now();
  $('elapsed').textContent = '0.0s';
  timerId = setInterval(() => { $('elapsed').textContent = `${((performance.now() - startedAt) / 1000).toFixed(1)}s`; }, 100);
}
function stopTimer() { clearInterval(timerId); timerId = null; }
function showProgress(label) { $('progressLabel').textContent = label; $('progress').classList.add('show'); }
function hideProgress() { $('progress').classList.remove('show'); }

/* ---------------- form fields ---------------- */
function buildCountFields(container, module) {
  container.innerHTML = '';
  for (const def of WEIGHTS[state.level][module]) {
    const val = clampInt(state[module][def.key] ?? 0, 0, def.count);
    state[module][def.key] = val;
    const row = document.createElement('div');
    row.className = 'count-row';
    row.innerHTML = `
      <div class="cname">${def.name}<small>每题 ${def.each} 分</small></div>
      <div style="display:flex;align-items:center">
        <div class="stepper">
          <button type="button" data-d="-1" aria-label="减少">−</button>
          <input type="number" min="0" max="${def.count}" step="1" value="${val}" inputmode="numeric" aria-label="${def.name}答对题数" />
          <button type="button" data-d="1" aria-label="增加">+</button>
        </div>
        <span class="of">/ ${def.count}</span>
      </div>`;
    const input = row.querySelector('input');
    const commit = () => { const n = clampInt(input.value, 0, def.count); state[module][def.key] = n; input.value = n; saveForm(); };
    input.addEventListener('input', () => { state[module][def.key] = clampInt(input.value, 0, def.count); saveForm(); });
    input.addEventListener('blur', commit);
    row.querySelectorAll('.stepper button').forEach(b => b.addEventListener('click', () => {
      const n = clampInt((state[module][def.key] ?? 0) + Number(b.dataset.d), 0, def.count);
      state[module][def.key] = n; input.value = n; saveForm();
    }));
    container.appendChild(row);
  }
}

function setLevel(next) {
  state.level = next;
  const seg = $('levelSeg');
  seg.dataset.level = next;
  seg.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.level === next)));
  buildCountFields($('listeningFields'), 'listening');
  buildCountFields($('readingFields'), 'reading');
  saveForm();
}

function applyModUI(mod) {
  const m = state[mod];
  const r = root();
  r.querySelectorAll(`.mode-seg[data-target="${mod}"] button`).forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === m.mode)));
  r.querySelectorAll(`.band-seg[data-target="${mod}"] button`).forEach(b => b.setAttribute('aria-pressed', String(b.dataset.band === m.band)));
  r.querySelector(`.band-seg[data-target="${mod}"]`).hidden = m.mode !== 'band';
  r.querySelector(`.ai-box[data-target="${mod}"]`).hidden = m.mode !== 'ai';
}

/* ---------------- result rendering ---------------- */
function resetResultUI() {
  $('emptyState').style.display = 'none';
  $('resultBar').classList.remove('show');
  $('errorCard').classList.remove('show');
  for (const id of ['overviewCard', 'modulesCard', 'aiCommentCard', 'recommendCard']) $(id).classList.remove('show');
  $('recommendBody').innerHTML = '';
  $('recommendStatus').textContent = '';
  delete $('recommendStatus').dataset.state;
  recRaw = '';
  recState = 'idle';
  hideProgress();
}
function showError(message) {
  hideProgress();
  $('errorMessage').textContent = message;
  $('errorCard').classList.add('show');
}

function renderEstimate() {
  const e = estimate;
  $('overviewHint').textContent = `${e.level === 'CET6' ? '六级 CET-6' : '四级 CET-4'} · 公开常模表插值与项目假设`;
  $('totalScore').textContent = e.total;
  $('scoreDial').style.setProperty('--score-angle', `${Math.max(0, Math.min(e.total, 710)) / 710 * 270}deg`);
  $('totalRange').textContent = `${e.range[0]} – ${e.range[1]}`;
  $('gapValue').textContent = `${e.gap >= 0 ? '+' : ''}${e.gap} 分`;
  $('gapValue').dataset.tone = e.gapTone;
  const [rangeLow, rangeHigh] = e.range;
  const targetInRange = rangeLow <= e.target && e.target <= rangeHigh;
  const rangeNote = targetInRange ? `，包含 ${e.target} 参考目标` : '';
  $('gapNote').textContent = `${e.gapLabel}。参考区间 ${rangeLow}–${rangeHigh}${rangeNote}。`;
  $('limits').textContent = e.limits;

  const list = $('moduleList');
  list.innerHTML = '';
  for (const m of e.modules) {
    const weak = e.weak.includes(m.key);
    const pct = Math.round((m.score / m.max) * 100);
    const el = document.createElement('div');
    el.className = `module${weak ? ' weak' : ''}`;
    el.innerHTML = `
      <div class="m-head">
        <span class="m-name">${m.name}</span>
        ${weak ? '<span class="m-weak">相对薄弱</span>' : ''}
        <span class="m-score">${m.score}<small> / ${m.max}</small></span>
      </div>
      <div class="m-bar"><i></i></div>
      <div class="m-pct">参考区间 ${m.range[0]}–${m.range[1]}<span class="m-source">模块来源：${moduleSources[m.key]}</span></div>`;
    list.appendChild(el);
    requestAnimationFrame(() => { el.querySelector('.m-bar i').style.width = `${pct}%`; });
  }

  const requested = ['writing', 'translation'].filter(mod => gradeRequested[mod]);
  const usedAI = requested.filter(mod => moduleSources[mod] === 'AI 语言反馈（参考）');
  $('resultTag').textContent = requested.length && usedAI.length === requested.length ? 'AI 语言反馈（参考）' : '按自评估算';
  $('resultMeta').textContent = `${e.level === 'CET6' ? '六级' : '四级'} · 总分约 ${e.total} · 参考区间 ${e.range[0]}–${e.range[1]}${requested.length && usedAI.length < requested.length ? ' · 写译部分按自评估算' : ''}`;
  $('overviewCard').classList.add('show');
  $('modulesCard').classList.add('show');
  $('resultBar').classList.add('show');
  $('recommendBtn').disabled = false;

  if (gradeRequested.writing || gradeRequested.translation) renderAiComments();
  if (window.innerWidth <= 920) $('overviewCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

const ERROR_LABEL = {
  spelling: '拼写', grammar: '语法', word_choice: '用词', collocation: '搭配',
  structure: '结构', coherence: '连贯', punctuation: '标点', content: '内容',
  omission: '漏译', misread: '误译', expression: '表达',
};
const esc = text => String(text ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

function gradeDetailHtml(c) {
  const errors = Array.isArray(c.errors) ? c.errors : [];
  const suggestions = Array.isArray(c.suggestions) ? c.suggestions : [];
  if (!errors.length && !suggestions.length) return '';
  const stats = Object.entries(c.stats || {})
    .map(([type, count]) => `<span class="gs-chip">${esc(ERROR_LABEL[type] || type)} × ${count}</span>`).join('');
  const errorList = errors.map(e => `
    <li class="ge-item">
      <div class="ge-top"><span class="ge-type">${esc(ERROR_LABEL[e.type] || e.type)}</span><mark>${esc(e.quote)}</mark></div>
      ${e.fix ? `<div class="ge-fix">建议：${esc(e.fix)}</div>` : ''}
      ${e.note ? `<div class="ge-note">${esc(e.note)}</div>` : ''}
    </li>`).join('');
  const suggest = suggestions.length
    ? `<div class="grade-suggest"><strong>改进建议</strong><ul>${suggestions.map(s => `<li>${esc(s)}</li>`).join('')}</ul></div>`
    : '';
  return `<div class="grade-detail">
      <div class="grade-detail-head"><span>逐句批改</span><span>${errors.length} 处</span></div>
      ${errorList ? `<ol class="grade-errors">${errorList}</ol>` : '<p class="muted">未发现可定位到原文的错误。</p>'}
      ${stats ? `<div class="grade-stats">${stats}</div>` : ''}
      ${suggest}
    </div>`;
}

function renderAiComments() {
  const body = $('aiCommentBody');
  body.innerHTML = '';
  let any = false;
  const requested = ['writing', 'translation'].filter(mod => gradeRequested[mod] && state[mod].mode === 'ai');
  if (requested.length && gradeState !== 'done') {
    any = true;
    const notice = document.createElement('div');
    notice.className = 'grade-state';
    const text = document.createElement('span');
    text.textContent = gradeMessage || '暂不可用，请重试。';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'btn btn-sm';
    retry.dataset.retryGrade = 'true';
    retry.textContent = '重试 AI 反馈';
    notice.append(text, retry);
    body.appendChild(notice);
  }
  for (const mod of requested) {
    const c = aiComments?.[mod];
    if (!c || !Number.isFinite(c.score)) {
      any = true;
      const unavailable = document.createElement('div');
      unavailable.className = 'ai-comment ai-unavailable';
      unavailable.innerHTML = `<div class="ac-head"><span class="ac-name">${MODULE_NAME[mod]}</span><span class="ac-score">按自评估算</span></div><p class="ac-text">AI 语言反馈暂不可用，请重试。</p>`;
      body.appendChild(unavailable);
      continue;
    }
    any = true;
    const checked = c.relevance === 'checked';
    const materialName = mod === 'writing' ? '作文题目' : '中文原文';
    const checkText = checked
      ? (mod === 'writing' ? '已判断切题' : '已判断信息覆盖')
      : `未判断${mod === 'writing' ? '切题' : '信息覆盖'}（缺${materialName}）`;
    const el = document.createElement('div');
    el.className = 'ai-comment';
    el.innerHTML = `
      <div class="ac-head">
        <span class="ac-name">${MODULE_NAME[mod]}</span>
        <span class="ac-band">${BAND_NAME[c.band] || ''}</span>
        <span class="ac-score">${c.score} / 15</span>
      </div>
      <div class="ac-check ${checked ? 'ok' : 'warn'}">${checkText}</div>
      <p class="ac-text"></p>
      <p class="ac-source">模块来源：AI 语言反馈（参考）</p>
      ${c.materialMissing ? `<p class="ac-missing">补填${materialName}后可判断${mod === 'writing' ? '切题与论点覆盖' : '信息覆盖与漏译'}；当前仅给语言层面反馈。</p>` : ''}
      ${gradeDetailHtml(c)}`;
    el.querySelector('.ac-text').textContent = c.comment || '';
    body.appendChild(el);
  }
  if (any && aiMeta) {
    const ms = Number(aiMeta.meta?.durationMs);
    const credits = aiMeta.usage?.totalCredits;
    const bits = [];
    if (Number.isFinite(ms) && ms > 0) bits.push(`评分耗时 ${(ms / 1000).toFixed(1)} 秒`);
    if (Number.isFinite(credits)) bits.push(`本次 ${credits} credits`);
    if (aiMeta.meta?.model) bits.push(`模型 ${aiMeta.meta.model}`);
    const footer = document.createElement('div');
    footer.className = 'grade-usage';
    footer.textContent = bits.length ? `服务端实测：${bits.join(' · ')}` : '服务端未返回本次评分用量数据。';
    body.appendChild(footer);
  }
  $('aiCommentCard').classList.toggle('show', any);
}

/* ---------------- AI grade ---------------- */
async function runGrade({ writing, writingPrompt, translation, translationSource }, signal) {
  await requireFeature('grade');
  let result = null;
  let state = 'done';
  const res = await fetch(`${API}?action=grade`, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ level: state.level, writing, writingPrompt, translation, translationSource }),
    signal,
  });
  if (!res.ok) {
    let msg = '暂不可用，请重试。';
    let code = '';
    try { const j = await res.json(); if (j?.message) msg = j.message; if (j?.error) code = j.error; } catch {}
    const error = new Error(aiErrorMessage({ code }, msg));
    error.code = code;
    throw error;
  }
  await consumeSSE(res, frame => {
    let env; try { env = JSON.parse(frame.data); } catch { return false; }
    if (env.type === 'status') { $('progressLabel').textContent = env.message; return false; }
    if (env.type === 'result') {
      result = { writing: env.writing, translation: env.translation, usage: env.usage, meta: env.meta };
      return false;
    }
    if (env.type === 'done') { state = env.state === 'partial' ? 'partial' : 'done'; return true; }
    if (env.type === 'error') {
      const error = new Error(aiErrorMessage({ code: env.code }, env.message));
      error.code = env.code || '';
      throw error;
    }
    return false;
  }, { signal });
  return result ? { ...result, state } : null;
}

/* ---------------- main estimate flow ---------------- */
async function startEstimate() {
  if (busy) return;
  saveForm();
  const wAI = state.writing.mode === 'ai';
  const tAI = state.translation.mode === 'ai';
  const wText = wAI ? $('writingText').value.trim() : '';
  const tText = tAI ? $('translationText').value.trim() : '';
  const wPrompt = wAI ? $('writingPrompt').value.trim() : '';
  const tSource = tAI ? $('translationSource').value.trim() : '';
  if ((wAI && wText.length > 0 && wText.length < 10) || (tAI && tText.length > 0 && tText.length < 10)) {
    toast('AI 反馈文本太短，请粘贴完整文本或切换为自评档位', 'err');
    return;
  }
  const needAI = (wAI && wText.length >= 10) || (tAI && tText.length >= 10);
  if (needAI) {
    const missing = [];
    if (wAI && wText.length >= 10 && !wPrompt) missing.push('作文题目');
    if (tAI && tText.length >= 10 && !tSource) missing.push('翻译中文原文');
    if (missing.length) toast(`未填写${missing.join(' / ')}，本次只给语言反馈`, 'ok');
  }

  busy = true;
  aiComments = null;
  aiMeta = null;
  estimate = null;
  gradeRequested = { writing: wAI && wText.length >= 10, translation: tAI && tText.length >= 10 };
  gradeState = needAI ? 'loading' : 'idle';
  gradeMessage = '';
  moduleSources = { listening: '用户自报', reading: '用户自报', writing: '按自评估算', translation: '按自评估算' };
  if (recAbort) { recAbort.abort(); recAbort = null; }
  recRunning = false;
  $('stopRecBtn').hidden = true;
  resetResultUI();
  $('estimateBtn').disabled = true;
  $('estimateLabel').textContent = needAI ? 'AI 反馈中…' : '估分中…';
  $('recommendBtn').disabled = true;

  if (needAI) {
    showProgress('正在准备 AI 引擎…');
    startTimer();
    gradeAbort = new AbortController();
    try {
      const result = await runGrade({ writing: wText, writingPrompt: wPrompt, translation: tText, translationSource: tSource }, gradeAbort.signal);
      if (!result) throw new Error('暂不可用，请重试。');
      aiComments = { writing: result.writing || null, translation: result.translation || null };
      aiMeta = { usage: result.usage, meta: result.meta };
      const missing = [];
      for (const mod of ['writing', 'translation']) {
        if (!gradeRequested[mod]) continue;
        if (Number.isFinite(aiComments[mod]?.score)) moduleSources[mod] = 'AI 语言反馈（参考）';
        else missing.push(MODULE_NAME[mod]);
      }
      gradeState = result.state === 'partial' || missing.length ? 'partial' : 'done';
      gradeMessage = gradeState === 'partial'
        ? `AI 语言反馈未完整生成；${missing.length ? `${missing.join('、')}按自评估算，` : ''}已保留可用反馈，可重试。`
        : '';
    } catch (err) {
      if (gradeAbort?.signal.aborted) {
        gradeState = 'cancelled';
        gradeMessage = '已取消 AI 语言反馈；本次按自评估算，可重试。';
      } else {
        gradeState = 'unavailable';
        gradeMessage = 'AI 语言反馈暂不可用；本次按自评估算，可重试。';
      }
      toast(`${aiErrorMessage(err)}本次按自评估算。`, 'err');
    } finally {
      gradeAbort = null;
    }
  }

  const input = {
    level: state.level,
    listening: { ...state.listening },
    reading: { ...state.reading },
    writing: moduleSources.writing === 'AI 语言反馈（参考）'
      ? { mode: 'ai', score: aiComments.writing.score }
      : { mode: 'band', band: state.writing.band },
    translation: moduleSources.translation === 'AI 语言反馈（参考）'
      ? { mode: 'ai', score: aiComments.translation.score }
      : { mode: 'band', band: state.translation.band },
  };
  estimate = computeEstimate(input);
  stopTimer();
  hideProgress();
  renderEstimate();
  $('estimateBtn').disabled = false;
  $('estimateLabel').textContent = '开始估分';
  busy = false;
}

/* ---------------- recommendation flow ---------------- */
function paintRecommend() {
  let html = renderMarkdown(recRaw);
  if (recRunning) html += '<span class="caret" aria-hidden="true"></span>';
  $('recommendBody').innerHTML = html;
}

function setRecommendStatus(state, text) {
  recState = state;
  $('recommendStatus').dataset.state = state;
  $('recommendStatus').textContent = text;
}

function finishRecommend(state, message) {
  recRunning = false;
  recState = state;
  $('stopRecBtn').hidden = true;
  $('recommendBtn').disabled = false;
  setRecommendStatus(state, message);
  paintRecommend();
}

async function startRecommend() {
  if (!estimate) { toast('请先完成估分', 'err'); return; }
  if (recRunning) return;
  try {
    await requireFeature('recommend');
  } catch (err) {
    $('recommendCard').classList.add('show');
    const message = recRaw.trim() && recState === 'partial' ? `建议未完整生成；${aiErrorMessage(err)}` : aiErrorMessage(err);
    setRecommendStatus('error', message);
    paintRecommend();
    toast(message, 'err');
    return;
  }
  recRunning = true;
  recRaw = '';
  recAbort = new AbortController();
  $('recommendCard').classList.add('show');
  setRecommendStatus('loading', '正在生成备考建议…');
  $('recommendBody').innerHTML = '<p class="muted">正在生成备考建议…</p>';
  $('stopRecBtn').hidden = false;
  $('recommendBtn').disabled = true;
  $('recommendCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  try {
    const res = await fetch(`${API}?action=recommend`, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: state.level, estimate }),
      signal: recAbort.signal,
    });
    if (!res.ok) {
      let msg = '暂不可用，请重试。';
      let code = '';
      try { const j = await res.json(); if (j?.message) msg = j.message; if (j?.error) code = j.error; } catch {}
      const error = new Error(aiErrorMessage({ code }, msg));
      error.code = code;
      throw error;
    }
    await consumeSSE(res, frame => {
      let env; try { env = JSON.parse(frame.data); } catch { return false; }
      if (env.type === 'delta') { recRaw += env.text; paintRecommend(); return false; }
      if (env.type === 'replace') { recRaw = env.text; paintRecommend(); return false; }
      if (env.type === 'done') {
        if (!recRaw.trim()) finishRecommend('error', '暂不可用，请重试。');
        else finishRecommend(env.state === 'partial' ? 'partial' : 'done', env.state === 'partial' ? '建议未完整生成，已保留现有内容，可重试。' : '备考建议已生成。');
        return true;
      }
      if (env.type === 'error') {
        const error = new Error(aiErrorMessage({ code: env.code }, env.message));
        error.code = env.code || '';
        throw error;
      }
      return false;
    }, { signal: recAbort.signal });
  } catch (err) {
    if (recAbort?.signal.aborted) {
      finishRecommend(recRaw.trim() ? 'partial' : 'cancelled', recRaw.trim() ? '已停止生成，建议未完整生成；已保留现有内容，可重试。' : '已停止生成，可重试。');
      toast('已停止生成');
    } else if (recRaw.trim()) {
      finishRecommend('partial', `建议未完整生成：${aiErrorMessage(err)} 已保留现有内容，可重试。`);
      toast('建议未完整生成，可重试', 'err');
    } else {
      finishRecommend('error', aiErrorMessage(err));
      toast(aiErrorMessage(err), 'err');
    }
  } finally {
    recAbort = null;
  }
}

/* ---------------- wiring ---------------- */
$('levelSeg').querySelectorAll('button').forEach(b => b.addEventListener('click', () => setLevel(b.dataset.level)));
root().querySelectorAll('.mode-seg button').forEach(b => b.addEventListener('click', () => {
  const mod = b.closest('.mode-seg').dataset.target;
  state[mod].mode = b.dataset.mode;
  applyModUI(mod); saveForm();
}));
root().querySelectorAll('.band-seg button').forEach(b => b.addEventListener('click', () => {
  const mod = b.closest('.band-seg').dataset.target;
  state[mod].band = b.dataset.band;
  applyModUI(mod); saveForm();
}));
wireScanner('writing');
wireScanner('translation');
$('writingText').addEventListener('input', saveForm);
$('writingPrompt').addEventListener('input', saveForm);
$('translationText').addEventListener('input', saveForm);
$('translationSource').addEventListener('input', saveForm);
$('form').addEventListener('submit', e => { e.preventDefault(); startEstimate(); });
$('recommendBtn').addEventListener('click', startRecommend);
$('reestimateBtn').addEventListener('click', () => { $('form').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
$('stopRecBtn').addEventListener('click', () => { if (recAbort) recAbort.abort(); });
$('errorRetryBtn').addEventListener('click', startEstimate);
$('aiCommentBody').addEventListener('click', e => {
  if (e.target.closest('[data-retry-grade]')) startEstimate();
});

/* ---------------- init ---------------- */
loadForm();
$('writingText').value = state.writing.text;
$('writingPrompt').value = state.writing.prompt;
$('translationText').value = state.translation.text;
$('translationSource').value = state.translation.source;
setLevel(state.level);
applyModUI('writing');
applyModUI('translation');
updateCapabilityUI();
onCapabilities(updateCapabilityUI);
