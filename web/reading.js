// On-demand reading tool. Instead of one giant analysis request (which the
// Sites gateway truncates around 60s), each section is a short independent
// request. Long passages are split into translation chunks; a failed chunk can
// be retried alone while earlier chunks stay on screen. Vocabulary export is
// preserved. The lab is the primary entry; this tool is for users who only
// want translation / vocabulary / grammar.
import { renderMarkdown } from './markdown.js';
import { consumeSSE } from './sse.mjs';
import { SAMPLE_TEXT } from './sample.js';
import { aiErrorMessage, getCapabilities, isFeatureEnabled, onCapabilities, refreshCapabilities, requireFeature, toast } from './shell.js';
import { photoFileError, transcribePhoto, confidenceLabel, wirePhotoDropPaste } from './scan.js';

const $ = id => document.getElementById(id);
const input = $('toolInput');
const charCount = $('toolCharCount');
const levelSeg = $('toolLevelSeg');
const MAX_INPUT = 12000;
const CHUNK_SIZE = 1100;

let level = localStorage.getItem('cet.tool.level') === 'CET6' ? 'CET6' : 'CET4';
let vocabData = null;

const trans = { chunks: [], results: [], incomplete: [], live: '', busy: false };
const vocab = { raw: '', busy: false };
const grammar = { raw: '', busy: false };
const scan = { busy: false, lastFile: null, controller: null, rotate: 0 };
const sectionStates = { translation: 'idle', vocab: 'idle', grammar: 'idle' };

/* ---------------- helpers ---------------- */
function updateCount() {
  const n = input.value.length;
  charCount.textContent = `${n} / ${MAX_INPUT}`;
  charCount.classList.toggle('over', n > MAX_INPUT);
}

function saveDraft() {
  try { localStorage.setItem('cet.tool.draft', input.value); } catch { /* storage full */ }
}

function setLevel(next) {
  level = next;
  levelSeg.dataset.level = next;
  levelSeg.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.level === next)));
  localStorage.setItem('cet.tool.level', next);
}

function getText() {
  return input.value.trim();
}

function updateModeBadges() {
  const enabled = isFeatureEnabled('explain');
  const el = $('toolModeBadge');
  el.dataset.mode = enabled ? 'live' : 'down';
  el.textContent = enabled ? 'AI 解析可用' : 'AI 解析暂不可用';
}

function updateScanAvailability() {
  const enabled = isFeatureEnabled('scan');
  $('toolScanBox').querySelector('.scan-entry').hidden = !enabled;
  $('toolScanUnavailable').hidden = enabled;
  $('toolScanCapabilityRetry').hidden = enabled || getCapabilities().status !== 'unknown';
}

function unavailableMessage(error) {
  return aiErrorMessage(error);
}

function showSection(key) {
  $(`tool-sec-${key}`).classList.add('show');
}

function setSectionStatus(key, state, text) {
  sectionStates[key] = state;
  const el = $(`tool-status-${key}`);
  el.dataset.state = state;
  el.textContent = text || '';
  $(`tool-retry-${key}`).hidden = !['error', 'partial', 'cancelled'].includes(state);
}

function setBusy(key, busy) {
  const map = { trans: 'toolTransBtn', vocab: 'toolVocabBtn', grammar: 'toolGrammarBtn' };
  const btn = $(map[key]);
  if (btn) btn.disabled = busy;
  if (key === 'trans') trans.busy = busy;
  if (key === 'vocab') vocab.busy = busy;
  if (key === 'grammar') grammar.busy = busy;
}

/* ---------------- photo import ---------------- */
function setScanStatus(tone, text) {
  const el = $('toolScanStatus');
  el.hidden = !text;
  if (tone) el.dataset.state = tone;
  else delete el.dataset.state;
  el.textContent = text || '';
}

function setScanBusy(on) {
  scan.busy = on;
  for (const id of ['toolScanBtn', 'toolScanRotate', 'toolScanRetry', 'toolScanClear']) $(id).disabled = on;
}

function clearScanPhoto() {
  scan.lastFile = null;
  scan.rotate = 0;
  $('toolScanImg').removeAttribute('src');
  $('toolScanPreview').hidden = true;
  $('toolScanClear').hidden = true;
  $('toolScanRotate').hidden = true;
  $('toolScanRetry').hidden = true;
  $('toolScanFile').value = '';
  setScanStatus('', '');
}

async function runReadingScan(file, { bypassCache = false } = {}) {
  if (scan.busy || !isFeatureEnabled('scan')) return;
  scan.lastFile = file;
  if (getText() && !window.confirm('识别结果会替换当前原文，已生成的翻译/生词结果会清空。继续吗？')) return;
  scan.busy = true;
  scan.controller = new AbortController();
  const timer = setTimeout(() => scan.controller.abort(), 90000);
  setScanBusy(true);
  $('toolScanRetry').hidden = true;
  setScanStatus('loading', '正在压缩照片…');
  try {
    const res = await transcribePhoto(file, {
      target: 'reading',
      level,
      rotate: scan.rotate,
      bypassCache,
      signal: scan.controller.signal,
      onStatus: (tone, msg) => setScanStatus(tone, msg),
      onPreview: dataUrl => {
        $('toolScanImg').src = dataUrl;
        $('toolScanPreview').hidden = false;
        $('toolScanClear').hidden = false;
        $('toolScanRotate').hidden = false;
      },
    });
    const { text, confidence, notes } = res;
    if (text.length > MAX_INPUT) {
      throw new Error(`识别到 ${text.length} 字符，超过 ${MAX_INPUT} 上限，请只拍一页或分段导入。`);
    }
    resetResults();
    input.value = text;
    updateCount();
    saveDraft();
    input.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const note = notes ? `（${notes}）` : '';
    const ms = Number(res.meta?.durationMs);
    const credits = res.usage?.totalCredits;
    const usage = res.cached ? '复用已有识别结果'
      : [Number.isFinite(ms) && ms > 0 ? `${(ms / 1000).toFixed(1)}s` : '', Number.isFinite(credits) ? `${credits} credits` : ''].filter(Boolean).join(' · ');
    setScanStatus(confidence === 'low' ? 'warn' : 'done',
      `识别完成，可信度${confidenceLabel(confidence)}${note}${usage ? `（${usage}）` : ''}。已填入原文框，请核对修改后按需解析。`);
    toast('已导入原文，可先修改再解析');
  } catch (err) {
    if (scan.controller?.signal.aborted) setScanStatus('error', '识别超时或已取消，可重试或重新拍照。');
    else setScanStatus('error', unavailableMessage(err));
    $('toolScanRetry').hidden = !scan.lastFile;
  } finally {
    clearTimeout(timer);
    scan.busy = false;
    scan.controller = null;
    setScanBusy(false);
  }
}

/* ---------------- chunking ---------------- */
function splitChunks(text) {
  const paras = text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  const chunks = [];
  let cur = '';
  const push = () => { if (cur.trim()) chunks.push(cur.trim()); cur = ''; };
  for (const p of (paras.length ? paras : [text])) {
    if (p.length <= CHUNK_SIZE) {
      if ((cur ? `${cur}\n\n${p}` : p).length > CHUNK_SIZE) push();
      cur = cur ? `${cur}\n\n${p}` : p;
      continue;
    }
    const sentences = p.split(/(?<=[.!?])\s+/).filter(Boolean);
    for (const s of sentences) {
      const next = cur ? `${cur} ${s}` : s;
      if (next.length > CHUNK_SIZE) push();
      cur = cur ? `${cur} ${s}` : s;
    }
  }
  push();
  if (chunks.length > 1 && chunks[chunks.length - 1].length < 20) {
    chunks[chunks.length - 2] += '\n\n' + chunks.pop();
  }
  return chunks.length ? chunks : [text];
}

/* ---------------- transport ---------------- */
async function streamExplain(section, text, part, total, handlers = {}) {
  await requireFeature('explain');
  const res = await fetch('/functions/v1/app?action=explain', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ section, text, level, part, total }),
  });
  if (!res.ok) {
    let msg = '暂不可用，请重试。';
    let code = '';
    try { const j = await res.json(); if (j?.message) msg = j.message; if (j?.error) code = j.error; } catch {}
    const error = new Error(aiErrorMessage({ code }, msg));
    error.code = code;
    throw error;
  }
  let out = '';
  let complete = false;
  let state = 'done';
  try {
    await consumeSSE(res, frame => {
      let env;
      try { env = JSON.parse(frame.data); } catch { return false; }
      if (env.type === 'status') { if (env.message) setSectionStatus(section, 'loading', env.message); return false; }
      if (env.type === 'delta') { out += env.text; handlers.onDelta?.(env.text); return false; }
      if (env.type === 'replace') { out = env.text; handlers.onReplace?.(env.text); return false; }
      if (env.type === 'done') { complete = true; state = env.state === 'partial' ? 'partial' : 'done'; return true; }
      if (env.type === 'error') {
        const error = new Error(aiErrorMessage({ code: env.code }, env.message));
        error.code = env.code || '';
        throw error;
      }
      return false;
    });
  } catch (error) {
    if (error?.code === 'sse_incomplete') error.code = 'sse_incomplete';
    throw error;
  }
  if (!out.trim()) throw new Error('AI 未返回有效内容，请重试。');
  return { text: out, state: complete ? state : 'partial' };
}

/* ---------------- translation ---------------- */
function paintTranslation() {
  const parts = trans.results.map((r, i) => r || (i === trans.results.findIndex(v => !v) ? trans.live : '')).filter(Boolean);
  const body = $('tool-body-translation');
  body.innerHTML = parts.length
    ? renderMarkdown(parts.join('\n\n'))
    : sectionStates.translation === 'loading'
      ? '<p class="muted">加载中…</p>'
      : sectionStates.translation === 'idle' ? '' : '<p class="muted">暂不可用，请重试。</p>';
}

async function runTranslation(start) {
  if (trans.busy) return;
  if (!trans.chunks.length) return;
  setBusy('trans', true);
  showSection('translation');
  for (let i = start; i < trans.chunks.length; i++) {
    trans.live = '';
    setSectionStatus('translation', 'loading', `正在翻译第 ${i + 1}/${trans.chunks.length} 段…`);
    paintTranslation();
    try {
      const result = await streamExplain('translation', trans.chunks[i], i + 1, trans.chunks.length, {
        onDelta: chunk => { trans.live += chunk; paintTranslation(); },
        onReplace: chunk => { trans.live = chunk; paintTranslation(); },
      });
      trans.results[i] = result.text.trim();
      trans.incomplete[i] = result.state === 'partial';
      trans.live = '';
      if (trans.incomplete[i]) {
        setBusy('trans', false);
        setSectionStatus('translation', 'partial', `第 ${i + 1}/${trans.chunks.length} 段未完整生成，已保留现有内容，可重试失败段。`);
        paintTranslation();
        return;
      }
    } catch (err) {
      const hasPartial = Boolean(trans.live.trim() || trans.incomplete[i] || trans.results[i]?.trim());
      if (trans.live.trim()) {
        trans.results[i] = trans.live.trim();
        trans.incomplete[i] = true;
      }
      trans.live = '';
      setBusy('trans', false);
      setSectionStatus('translation', hasPartial ? 'partial' : 'error', `第 ${i + 1}/${trans.chunks.length} 段${hasPartial ? '未完整生成' : '失败'}：${unavailableMessage(err)} ${hasPartial ? '已保留生成内容。' : i > 0 ? '已保留已完成段落。' : ''}可重试失败段。`);
      paintTranslation();
      return;
    }
  }
  setBusy('trans', false);
  setSectionStatus('translation', 'done', `已加载 ${trans.chunks.length}/${trans.chunks.length} 段翻译。`);
  paintTranslation();
}

async function loadTranslation() {
  if (trans.busy) return;
  const text = getText();
  if (text.length < 20) { toast('请先粘贴至少 20 个字符的原文', 'err'); input.focus(); return; }
  if (text.length > MAX_INPUT) { toast('内容过长，请控制在 12000 字符以内', 'err'); return; }
  updateModeBadges();
  trans.chunks = splitChunks(text);
  trans.results = new Array(trans.chunks.length).fill('');
  trans.incomplete = new Array(trans.chunks.length).fill(false);
  trans.live = '';
  $('tool-body-translation').innerHTML = '';
  await runTranslation(0);
}

/* ---------------- vocab ---------------- */
function stripVocab(text) {
  let t = text.replace(/<!--VOCAB[\s\S]*?VOCAB-->/g, '');
  const open = t.lastIndexOf('<!--');
  if (open >= 0 && t.indexOf('-->', open) < 0) t = t.slice(0, open);
  return t.replace(/\s+$/, '');
}

function extractVocab(text) {
  const m = text.match(/<!--VOCAB\s*([\s\S]*?)\s*VOCAB-->/);
  if (m) {
    try {
      const arr = JSON.parse(m[1]);
      if (Array.isArray(arr)) {
        const clean = arr.filter(x => x && typeof x.w === 'string' && x.w.trim())
          .map(x => ({ w: x.w.trim(), p: x.p || '', pos: x.pos || '', m: x.m || '', lv: x.lv === 'CET6' ? 'CET6' : 'CET4' }));
        if (clean.length) return clean;
      }
    } catch { /* fall back to table */ }
  }
  return null;
}

function vocabFromTable(text) {
  const out = [];
  for (const line of stripVocab(text).split('\n')) {
    if (!/^\s*\|/.test(line)) continue;
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
    if (cells.length < 5) continue;
    if (cells[0] === '单词' || /^[-:\s]+$/.test(cells[0])) continue;
    out.push({ w: cells[0], p: cells[1], pos: cells[2], m: cells[3], lv: /六级/.test(cells[4]) ? 'CET6' : 'CET4' });
  }
  return out.length ? out : null;
}

function paintVocab() {
  const body = $('tool-body-vocab');
  const visible = stripVocab(vocab.raw);
  body.innerHTML = visible.trim()
    ? renderMarkdown(visible)
    : sectionStates.vocab === 'loading'
      ? '<p class="muted">加载中…</p>'
      : sectionStates.vocab === 'idle' ? '' : '<p class="muted">暂不可用，请重试。</p>';
}

async function loadVocab() {
  if (vocab.busy) return;
  const text = getText();
  if (text.length < 20) { toast('请先粘贴至少 20 个字符的原文', 'err'); input.focus(); return; }
  if (text.length > MAX_INPUT) { toast('内容过长，请控制在 12000 字符以内', 'err'); return; }
  updateModeBadges();
  setBusy('vocab', true);
  showSection('vocab');
  vocab.raw = '';
  vocabData = null;
  $('toolExportBtn').disabled = true;
  paintVocab();
  setSectionStatus('vocab', 'loading', '正在提取重点生词…');
  try {
    const result = await streamExplain('vocab', text, 1, 1, {
      onDelta: chunk => { vocab.raw += chunk; paintVocab(); },
      onReplace: chunk => { vocab.raw = chunk; paintVocab(); },
    });
    vocab.raw = result.text;
    vocabData = result.state === 'done' ? extractVocab(vocab.raw) || vocabFromTable(vocab.raw) : null;
    paintVocab();
    $('toolExportBtn').disabled = !vocabData;
    if (result.state === 'partial') setSectionStatus('vocab', 'partial', '生词结果未完整生成，已保留现有内容，可重试。');
    else setSectionStatus('vocab', 'done', vocabData ? `已提取 ${vocabData.length} 个生词，可导出默写清单。` : '已返回生词表，但未识别到可导出的结构。');
  } catch (err) {
    setSectionStatus('vocab', vocab.raw.trim() ? 'partial' : 'error', `${vocab.raw.trim() ? '生词结果未完整生成' : '暂不可用'}：${unavailableMessage(err)} 可重试。`);
    paintVocab();
  } finally {
    setBusy('vocab', false);
  }
}

/* ---------------- grammar ---------------- */
function paintGrammar() {
  const body = $('tool-body-grammar');
  body.innerHTML = grammar.raw.trim()
    ? renderMarkdown(grammar.raw)
    : sectionStates.grammar === 'loading'
      ? '<p class="muted">加载中…</p>'
      : sectionStates.grammar === 'idle' ? '' : '<p class="muted">暂不可用，请重试。</p>';
}

async function loadGrammar() {
  if (grammar.busy) return;
  const text = getText();
  if (text.length < 20) { toast('请先粘贴至少 20 个字符的原文', 'err'); input.focus(); return; }
  if (text.length > MAX_INPUT) { toast('内容过长，请控制在 12000 字符以内', 'err'); return; }
  updateModeBadges();
  setBusy('grammar', true);
  showSection('grammar');
  grammar.raw = '';
  paintGrammar();
  setSectionStatus('grammar', 'loading', '正在拆解长难句…');
  try {
    const result = await streamExplain('grammar', text, 1, 1, {
      onDelta: chunk => { grammar.raw += chunk; paintGrammar(); },
      onReplace: chunk => { grammar.raw = chunk; paintGrammar(); },
    });
    grammar.raw = result.text;
    paintGrammar();
    if (result.state === 'partial') setSectionStatus('grammar', 'partial', '长难句拆解未完整生成，已保留现有内容，可重试。');
    else setSectionStatus('grammar', 'done', '长难句拆解完成。');
  } catch (err) {
    setSectionStatus('grammar', grammar.raw.trim() ? 'partial' : 'error', `${grammar.raw.trim() ? '拆解未完整生成' : '暂不可用'}：${unavailableMessage(err)} 可重试。`);
    paintGrammar();
  } finally {
    setBusy('grammar', false);
  }
}

/* ---------------- export / copy / reset ---------------- */
function buildDictation(list) {
  const date = new Date().toISOString().slice(0, 10);
  const lvLabel = level === 'CET6' ? '六级 CET-6' : '四级 CET-4';
  const bar = '='.repeat(46);
  const thin = '-'.repeat(46);
  const L = [];
  L.push('四六级阅读 · 生词默写清单');
  L.push(`生成日期：${date}    级别：${lvLabel}    共 ${list.length} 词`);
  L.push(bar);
  L.push('说明：看单词与音标，在横线上默写中文释义；参考答案见文末。');
  L.push('');
  list.forEach((v, i) => {
    L.push(`${String(i + 1).padStart(2, ' ')}. ${v.w}   ${v.p}   ${v.pos}`.trimEnd());
    L.push(`    释义：${'_'.repeat(30)}`);
    L.push('');
  });
  L.push(thin);
  L.push('参考答案');
  L.push(thin);
  list.forEach((v, i) => {
    L.push(`${String(i + 1).padStart(2, ' ')}. ${v.w}   ${v.pos}   ${v.m}   [${v.lv === 'CET6' ? '六级' : '四级'}]`);
  });
  L.push('');
  L.push('—— 由四六级阅读错因实验室 · 阅读工具生成 ——');
  return L.join('\r\n');
}

function exportDictation() {
  if (!vocabData || !vocabData.length) { toast('未识别到生词，暂无法导出', 'err'); return; }
  const content = '\uFEFF' + buildDictation(vocabData);
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `四六级生词默写清单_${new Date().toISOString().slice(0, 10)}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`已导出 ${vocabData.length} 个生词的默写清单`);
}

function combinedText() {
  const out = [];
  const t = trans.results.filter(Boolean).join('\n\n');
  if (t) out.push(`## 全文翻译\n\n${t}`);
  const v = stripVocab(vocab.raw);
  if (v.trim()) out.push(`## 重点生词\n\n${v}`);
  if (grammar.raw.trim()) out.push(`## 长难句拆解\n\n${grammar.raw.trim()}`);
  return out.join('\n\n');
}

async function copyAll() {
  const text = combinedText().trim();
  if (!text) { toast('暂无可复制的结果', 'err'); return; }
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制已加载的结果');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('已复制已加载的结果'); }
    catch { toast('复制失败，请手动选择文本', 'err'); }
    ta.remove();
  }
}

function resetResults() {
  trans.chunks = []; trans.results = []; trans.incomplete = []; trans.live = '';
  vocab.raw = ''; grammar.raw = '';
  vocabData = null;
  for (const key of ['translation', 'vocab', 'grammar']) {
    $(`tool-sec-${key}`).classList.remove('show');
    $(`tool-body-${key}`).innerHTML = '';
    setSectionStatus(key, 'idle', '');
  }
  $('toolExportBtn').disabled = true;
  $('toolTag').textContent = '按需加载';
  $('toolMeta').textContent = '';
}

/* ---------------- wiring ---------------- */
function loadSample() {
  input.value = SAMPLE_TEXT;
  updateCount();
  saveDraft();
  toast('已载入原创文章');
  input.focus();
}

levelSeg.querySelectorAll('button').forEach(b => b.addEventListener('click', () => setLevel(b.dataset.level)));
input.addEventListener('input', () => { updateCount(); saveDraft(); });
input.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); loadTranslation(); }
});
$('toolSampleBtn').addEventListener('click', loadSample);
$('toolClearBtn').addEventListener('click', () => {
  input.value = '';
  updateCount();
  saveDraft();
  resetResults();
  if (!scan.busy) clearScanPhoto();
  input.focus();
});
$('toolScanBtn').addEventListener('click', () => { if (isFeatureEnabled('scan')) $('toolScanFile').click(); });
$('toolScanCapabilityRetry').addEventListener('click', () => { void refreshCapabilities(); });
$('toolScanFile').addEventListener('change', e => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  const err = photoFileError(file);
  if (err) { toast(err, 'err'); return; }
  scan.rotate = 0;
  runReadingScan(file);
});
$('toolScanRotate').addEventListener('click', () => {
  if (!scan.lastFile || scan.busy) return;
  scan.rotate = (scan.rotate + 90) % 360;
  runReadingScan(scan.lastFile, { bypassCache: true });
});
$('toolScanRetry').addEventListener('click', () => { if (scan.lastFile) runReadingScan(scan.lastFile, { bypassCache: true }); });
$('toolScanClear').addEventListener('click', () => { if (!scan.busy) clearScanPhoto(); });
wirePhotoDropPaste($('toolScanBox') || input, file => {
  if (scan.busy) return;
  const err = photoFileError(file);
  if (err) { toast(err, 'err'); return; }
  scan.rotate = 0;
  runReadingScan(file);
}, { onError: msg => toast(msg, 'err'), enabled: () => isFeatureEnabled('scan') });
$('toolTransBtn').addEventListener('click', loadTranslation);
$('toolVocabBtn').addEventListener('click', loadVocab);
$('toolGrammarBtn').addEventListener('click', loadGrammar);
$('tool-retry-translation').addEventListener('click', () => {
  const i = trans.results.findIndex((r, idx) => !r || trans.incomplete[idx]);
  runTranslation(i < 0 ? 0 : i);
});
$('tool-retry-vocab').addEventListener('click', loadVocab);
$('tool-retry-grammar').addEventListener('click', loadGrammar);
$('toolExportBtn').addEventListener('click', exportDictation);
$('toolCopyBtn').addEventListener('click', copyAll);
$('toolResetBtn').addEventListener('click', resetResults);

/* ---------------- init ---------------- */
setLevel(level);
const draft = localStorage.getItem('cet.tool.draft');
if (draft) input.value = draft;
updateCount();
updateModeBadges();
updateScanAvailability();
onCapabilities(() => { updateModeBadges(); updateScanAvailability(); });
