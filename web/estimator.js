import { WEIGHTS, BANDS, computeEstimate } from './engine.js';
import { consumeSSE } from './sse.mjs';
import { renderMarkdown } from './markdown.js';
import { toast } from './shell.js';

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
let busy = false;
let gradeAbort = null;
let recAbort = null;
let recRaw = '';
let recRunning = false;
let timerId = null;
let startedAt = 0;

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
  recRaw = '';
  hideProgress();
}
function showError(message) {
  hideProgress();
  $('errorMessage').textContent = message;
  $('errorCard').classList.add('show');
}

function renderEstimate() {
  const e = estimate;
  $('overviewHint').textContent = `${e.level === 'CET6' ? '六级 CET-6' : '四级 CET-4'} · 公开常模表插值 + 经验校准`;
  $('totalScore').textContent = e.total;
  $('totalRange').textContent = `${e.range[0]} – ${e.range[1]}`;
  $('gapValue').textContent = `${e.gap >= 0 ? '+' : ''}${e.gap} 分`;
  $('gapValue').dataset.tone = e.gapTone;
  $('gapNote').textContent = `${e.gapLabel}。参考区间 ${e.range[0]}–${e.range[1]} 也可能跨过 425，请结合区间理解。`;
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
      <div class="m-pct">参考区间 ${m.range[0]}–${m.range[1]} · 参考得分率约 ${pct}%</div>`;
    list.appendChild(el);
    requestAnimationFrame(() => { el.querySelector('.m-bar i').style.width = `${pct}%`; });
  }

  $('resultTag').textContent = '参考估分完成';
  $('resultMeta').textContent = `${e.level === 'CET6' ? '六级' : '四级'} · 总分约 ${e.total} · 参考区间 ${e.range[0]}–${e.range[1]}`;
  $('overviewCard').classList.add('show');
  $('modulesCard').classList.add('show');
  $('resultBar').classList.add('show');
  $('recommendBtn').disabled = false;

  if (aiComments) renderAiComments();
  if (window.innerWidth <= 920) $('overviewCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderAiComments() {
  const body = $('aiCommentBody');
  body.innerHTML = '';
  let any = false;
  for (const mod of ['writing', 'translation']) {
    const c = aiComments[mod];
    if (!c || c.score === null || state[mod].mode !== 'ai') continue;
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
      ${c.materialMissing ? `<p class="ac-missing">补填${materialName}后可判断${mod === 'writing' ? '切题与论点覆盖' : '信息覆盖与漏译'}；当前仅给语言层面反馈。</p>` : ''}`;
    el.querySelector('.ac-text').textContent = c.comment || '';
    body.appendChild(el);
  }
  $('aiCommentCard').classList.toggle('show', any);
}

/* ---------------- AI grade ---------------- */
async function runGrade({ writing, writingPrompt, translation, translationSource }, signal) {
  let result = null;
  const res = await fetch(`${API}?action=grade`, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ level: state.level, writing, writingPrompt, translation, translationSource }),
    signal,
  });
  if (!res.ok) {
    let msg = 'AI 反馈请求失败。';
    try { const j = await res.json(); if (j?.message) msg = j.message; } catch { /* ignore */ }
    throw new Error(msg);
  }
  await consumeSSE(res, frame => {
    let env; try { env = JSON.parse(frame.data); } catch { return false; }
    if (env.type === 'status') { $('progressLabel').textContent = env.message; return false; }
    if (env.type === 'result') { result = { writing: env.writing, translation: env.translation }; return false; }
    if (env.type === 'done') return true;
    if (env.type === 'error') throw new Error(env.message || 'AI 反馈失败。');
    return false;
  }, { signal });
  return result;
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
  estimate = null;
  if (recAbort) { recAbort.abort(); recAbort = null; }
  resetResultUI();
  $('estimateBtn').disabled = true;
  $('estimateLabel').textContent = needAI ? 'AI 反馈中…' : '估分中…';
  $('recommendBtn').disabled = true;

  let scores = null;
  if (needAI) {
    showProgress('正在准备 AI 引擎…');
    startTimer();
    gradeAbort = new AbortController();
    try {
      const result = await runGrade({ writing: wText, writingPrompt: wPrompt, translation: tText, translationSource: tSource }, gradeAbort.signal);
      if (result) { scores = result; aiComments = result; }
    } catch (err) {
      if (gradeAbort.signal.aborted) toast('已取消 AI 反馈，改用自评档位');
      else toast(`${err.message || 'AI 反馈失败'}，已改用自评档位`, 'err');
    } finally {
      gradeAbort = null;
    }
  }

  const input = {
    level: state.level,
    listening: { ...state.listening },
    reading: { ...state.reading },
    writing: (wAI && scores && Number.isFinite(scores.writing?.score))
      ? { mode: 'ai', score: scores.writing.score }
      : { mode: 'band', band: state.writing.band },
    translation: (tAI && scores && Number.isFinite(scores.translation?.score))
      ? { mode: 'ai', score: scores.translation.score }
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
function finishRecommend() {
  recRunning = false;
  $('stopRecBtn').hidden = true;
  $('recommendBtn').disabled = false;
  paintRecommend();
}

async function startRecommend() {
  if (!estimate) { toast('请先完成估分', 'err'); return; }
  if (recRunning) return;
  recRunning = true;
  recRaw = '';
  recAbort = new AbortController();
  $('recommendCard').classList.add('show');
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
      let msg = '推荐请求失败。';
      try { const j = await res.json(); if (j?.message) msg = j.message; } catch { /* ignore */ }
      throw new Error(msg);
    }
    await consumeSSE(res, frame => {
      let env; try { env = JSON.parse(frame.data); } catch { return false; }
      if (env.type === 'delta') { recRaw += env.text; paintRecommend(); return false; }
      if (env.type === 'replace') { recRaw = env.text; paintRecommend(); return false; }
      if (env.type === 'done') { finishRecommend(); return true; }
      if (env.type === 'error') { throw new Error(env.message || '生成失败。'); }
      return false;
    }, { signal: recAbort.signal });
  } catch (err) {
    if (recAbort && recAbort.signal.aborted) { finishRecommend(); toast('已停止生成'); }
    else if (recRaw.trim()) { finishRecommend(); }
    else {
      recRunning = false;
      $('stopRecBtn').hidden = true;
      $('recommendBtn').disabled = false;
      $('recommendBody').innerHTML = '';
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = err.message || '生成失败，请重试。';
      $('recommendBody').appendChild(p);
      toast(err.message || '生成失败，请重试', 'err');
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
$('writingText').addEventListener('input', saveForm);
$('writingPrompt').addEventListener('input', saveForm);
$('translationText').addEventListener('input', saveForm);
$('translationSource').addEventListener('input', saveForm);
$('form').addEventListener('submit', e => { e.preventDefault(); startEstimate(); });
$('recommendBtn').addEventListener('click', startRecommend);
$('reestimateBtn').addEventListener('click', () => { $('form').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
$('stopRecBtn').addEventListener('click', () => { if (recAbort) recAbort.abort(); });
$('errorRetryBtn').addEventListener('click', startEstimate);

/* ---------------- init ---------------- */
loadForm();
setLevel(state.level);
$('writingText').value = state.writing.text;
$('writingPrompt').value = state.writing.prompt;
$('translationText').value = state.translation.text;
$('translationSource').value = state.translation.source;
applyModUI('writing');
applyModUI('translation');
