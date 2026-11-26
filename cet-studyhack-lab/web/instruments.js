// 科技皮肤的 CSS 3D 仪器：错因实验室 / 阅读工具 / 参考估分共用一套结构。
// 只读取各模块已经渲染出的真实状态（__labState、工具状态节点、估分结果节点），
// 不改动任何业务逻辑；简约皮肤下由 CSS 整体隐藏这些视觉件。
import { __labState } from './lab.js';

const $ = id => document.getElementById(id);

const TEMPLATE = `
  <div class="instr" data-state="idle" data-tone="" data-rail="4">
    <div class="instr-window">
      <div class="instr-scene" aria-hidden="true"></div>
      <i class="instr-scan" aria-hidden="true"></i>
      <span class="instr-rail" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
      <span class="instr-led" aria-hidden="true"></span>
      <span class="instr-hud">
        <b class="instr-value">—</b>
        <em class="instr-caption">STANDBY</em>
      </span>
      <span class="instr-lock" aria-hidden="true"></span>
      <span class="instr-dial" aria-hidden="true">
        <i class="instr-ticks"></i><i class="instr-needle"></i><b class="instr-hub"></b>
      </span>
    </div>
  </div>`;

const DEVICE_PLANS = {
  evidence: [[148, 17, 92, 32], [137, 12, 82, 14], [113, 9, 66, -6], [95, 7, 54, -27]],
  optics: [[150, 16, 88, 31], [130, 10, 78, 13], [87, 15, 60, -9], [71, 12, 48, -30]],
  calibration: [[157, 17, 82, 32], [141, 10, 73, 14], [111, 10, 59, -7], [82, 10, 49, -28]],
};

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

function fillScene(windowEl, planKey) {
  const plan = DEVICE_PLANS[planKey];
  if (!plan) return;
  windowEl.querySelector('.instr-scene').innerHTML = plan.map(([width, height, depth, level]) => `
    <span class="instr-slab" style="--width:${width}px;--height:${height}px;--depth:${depth}px;--level:${level}px">
      <i class="instr-face face-front"></i><i class="instr-face face-side"></i><i class="instr-face face-top"></i>
    </span>`).join('') + '<span class="instr-lens"></span>';
  windowEl.addEventListener('pointermove', event => {
    if (reducedMotion.matches || event.pointerType !== 'mouse') return;
    const rect = windowEl.getBoundingClientRect();
    const horizontal = (event.clientX - rect.left) / rect.width - .5;
    const vertical = (event.clientY - rect.top) / rect.height - .5;
    windowEl.style.setProperty('--device-yaw', `${horizontal * 35}deg`);
    windowEl.style.setProperty('--device-pitch', `${vertical * -18}deg`);
  });
  windowEl.addEventListener('pointerleave', () => {
    windowEl.style.removeProperty('--device-yaw');
    windowEl.style.removeProperty('--device-pitch');
  });
}

function mount(id, variant, label) {
  const host = $(id);
  if (!host) return null;
  host.innerHTML = TEMPLATE;
  const el = host.firstElementChild;
  el.classList.add(`instr--${variant}`);
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', label);
  const planKey = variant === 'tool' ? 'optics' : variant === 'est' ? 'calibration' : 'evidence';
  fillScene(el.querySelector('.instr-window'), planKey);
  const value = el.querySelector('.instr-value');
  const caption = el.querySelector('.instr-caption');
  const segs = [...el.querySelectorAll('.instr-rail i')];
  return {
    host,
    el,
    set(state, { tone = '', value: text, caption: cap, level = 0, rail, deg } = {}) {
      el.dataset.state = state;
      el.dataset.tone = tone;
      if (rail) el.dataset.rail = String(rail);
      if (text != null) value.textContent = text;
      if (cap != null) caption.textContent = cap;
      if (deg != null) el.style.setProperty('--deg', `${deg}deg`);
      const n = Math.max(0, Math.min(segs.length, level));
      segs.forEach((seg, i) => seg.classList.toggle('on', i < n));
    },
  };
}

const lab = mount('instrLab', 'lab', '阅读作答装配仪');
const tool = mount('instrTool', 'tool', '阅读分析扫描仪');
const est = mount('instrEst', 'est', '参考估分刻度盘');

const schedule = fn => {
  let frame = 0;
  return () => {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; fn(); });
  };
};

/* ---------------- 错因实验室：装配 / 锁定 ---------------- */
function syncLab() {
  if (!lab) return;
  const s = __labState;
  if (s.screen === 'pick' || s.screen === 'custom') {
    lab.host.hidden = true;
    return;
  }
  lab.host.hidden = false;
  const isTransfer = s.screen === 'transfer';
  const draft = isTransfer ? s.transfer?.draft : s.draft;
  const diagnosis = isTransfer ? s.transfer?.diagnosis : s.diagnosis;
  const level = Math.min(4, (draft?.choice ? 1 : 0) + (draft?.evidence?.length || 0));
  if (s.screen === 'result' || s.screen === 'summary' || (isTransfer && diagnosis)) {
    const tone = diagnosis ? (diagnosis.answer_correct ? 'ok' : 'bad') : '';
    lab.set('locked', {
      tone,
      level: 4,
      value: tone === 'ok' ? 'PASS' : 'REVIEW',
      caption: tone === 'ok' ? '已锁定 · ALIGNED' : '已锁定 · REVIEW',
    });
  } else if (s.screen === 'hint' || s.awaiting) {
    lab.set('armed', { level, value: `${level}/4`, caption: '提示已装载 · RE-ANSWER' });
  } else {
    lab.set('assemble', { level, value: `${level}/4`, caption: '装配中 · ASSEMBLING' });
  }
}

/* ---------------- 阅读工具：分析 / 拍照扫描 ---------------- */
const TOOL_KEYS = ['translation', 'vocab', 'grammar'];

function syncTool() {
  if (!tool) return;
  const scanEl = $('toolScanStatus');
  const photoState = scanEl && !scanEl.hidden ? (scanEl.dataset.state || '') : '';
  const states = TOOL_KEYS.map(key => $(`tool-status-${key}`)?.dataset.state || '');
  const shown = TOOL_KEYS.filter(key => $(`tool-sec-${key}`)?.classList.contains('show')).length;
  const analyzing = states.includes('loading');
  const partial = photoState === 'error' || photoState === 'warn' || states.some(s => s === 'error' || s === 'partial');
  let state = 'idle';
  let caption = '待装载 · STANDBY';
  let value = '—';
  let tone = '';
  if (photoState === 'loading') {
    state = 'scan';
    caption = '正在识别照片 · SCANNING';
    value = 'OCR';
  } else if (analyzing) {
    state = 'scan';
    caption = '分析中 · ANALYZING';
    value = `${shown}/3`;
  } else if (partial) {
    state = 'warn';
    caption = '部分结果 · PARTIAL';
    value = `${shown}/3`;
    tone = 'warn';
  } else if (photoState === 'done' && !shown) {
    state = 'done';
    caption = '识别完成 · OCR';
    value = 'OCR';
  } else if (shown) {
    state = 'done';
    caption = '分析就绪 · READY';
    value = `${shown}/3`;
  }
  tool.set(state, { tone, value, caption, level: shown, rail: 3 });
}

/* ---------------- 参考估分：与总分同步的刻度盘 ---------------- */
const DIAL_MIN = -130;
const DIAL_SPAN = 260;

function syncEst() {
  if (!est) return;
  const scoreEl = $('est-totalScore');
  const has = Boolean($('est-resultBar')?.classList.contains('show'));
  const total = Number(String(scoreEl?.textContent || '').replace(/[^\d]/g, '')) || 0;
  if (!has) {
    est.set('idle', { value: '—', caption: '待估分 · STANDBY', deg: DIAL_MIN });
    return;
  }
  const ratio = Math.max(0, Math.min(710, total)) / 710;
  est.set('locked', {
    tone: 'ok',
    value: String(total),
    caption: '参考估分 · OF 710',
    deg: DIAL_MIN + ratio * DIAL_SPAN,
  });
}

/* ---------------- 观察真实渲染结果 ---------------- */
const scheduleLab = schedule(syncLab);
const scheduleTool = schedule(syncTool);
const scheduleEst = schedule(syncEst);

function observe(target, options, run) {
  if (!target || typeof MutationObserver !== 'function') return;
  new MutationObserver(run).observe(target, options);
}

const labStage = $('labStage');
const labEmpty = $('labEmpty');
observe(labStage, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class', 'aria-pressed'] }, scheduleLab);
observe(labEmpty, { attributes: true, attributeFilter: ['hidden'] }, scheduleLab);

observe($('toolPanel'), { subtree: true, attributes: true, attributeFilter: ['class', 'data-state', 'hidden'] }, scheduleTool);

observe($('view-estimator'), {
  subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class'],
}, scheduleEst);

syncLab();
syncTool();
syncEst();
