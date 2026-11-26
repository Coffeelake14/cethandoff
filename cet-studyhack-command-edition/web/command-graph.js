import { ERROR_LABELS } from './lab-data.js';
import { escapeHtml } from './markdown.js';

export const GRAPH_NODES = [
  { id: 'reading', x: 0, y: 0, z: 34, core: true, mobilePrimary: true },
  { id: 'scope_expansion', x: -255, y: -122, z: 58, mobilePrimary: true },
  { id: 'causal_inversion', x: 238, y: -126, z: -18, mobilePrimary: true },
  { id: 'attitude_shift', x: 306, y: 18, z: 12, mobilePrimary: true },
  { id: 'detail_mismatch', x: 222, y: 156, z: -48 },
  { id: 'not_supported', x: -248, y: 140, z: 20 },
  { id: 'evidence_insufficient', x: -92, y: -212, z: -38 },
  { id: 'right_answer_wrong_evidence', x: -342, y: 4, z: -8 },
  { id: 'right_answer_uncertain', x: 18, y: 218, z: 44 },
  { id: 'none', x: 132, y: 186, z: -30 },
  { id: 'listening', x: -330, y: -184, z: -78, peripheral: true },
  { id: 'writing', x: 320, y: -188, z: -68, peripheral: true },
  { id: 'translation', x: 354, y: 172, z: -88, peripheral: true },
];

const MOBILE_IDS = new Set(GRAPH_NODES.filter(node => node.mobilePrimary).map(node => node.id));
const MODULE_LABELS = { reading: '阅读', listening: '听力', writing: '写作', translation: '翻译' };
const FOCAL = 940;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const compactLayout = matchMedia('(max-width: 767px)');
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function graphNodeLabel(id) {
  return MODULE_LABELS[id] || ERROR_LABELS[id] || id;
}

function countFor(nodeId, records) {
  const main = records.filter(record => record.kind === 'main' && record.firstAnswer?.judgeable);
  if (nodeId === 'reading') return main.length;
  return main.filter(record => record.errorType === nodeId).length;
}

function textWidth(text, size = 11) {
  return [...String(text)].reduce((width, char) => width + (/[\x00-\xff]/.test(char) ? size * .58 : size), 0);
}

function project(node, yaw, pitch) {
  const ry = yaw * Math.PI / 180;
  const rx = pitch * Math.PI / 180;
  const cosY = Math.cos(ry), sinY = Math.sin(ry);
  const cosX = Math.cos(rx), sinX = Math.sin(rx);
  const x1 = node.x * cosY + node.z * sinY;
  const z1 = -node.x * sinY + node.z * cosY;
  const y1 = node.y * cosX - z1 * sinX;
  const z2 = node.y * sinX + z1 * cosX;
  const depth = FOCAL / (FOCAL - z2);
  return { x: x1 * depth, y: y1 * depth, depth };
}

function visibleNodes(compact) {
  return compact ? GRAPH_NODES.filter(node => MOBILE_IDS.has(node.id)) : GRAPH_NODES;
}

function layoutNodes(width, height, compact) {
  const nodes = visibleNodes(compact);
  const projected = nodes.map(node => ({ node, point: project(node, state.yaw, state.pitch) }));
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const item of projected) {
    const { node, point } = item;
    const label = graphNodeLabel(node.id);
    const count = countFor(node.id, state.records);
    const labelSize = node.core ? 15 : (compact ? 10.5 : 11);
    const labelW = textWidth(label, labelSize) + (count ? textWidth(` ${count}次记录`, 9) + 8 : 0);
    item.labelW = labelW;
    item.side = node.core ? 'bottom' : point.x < 0 ? 'right' : 'left';
    const left = item.side === 'left' ? point.x - 24 - labelW : point.x - 24;
    const right = item.side === 'right' ? point.x + 24 + labelW : point.x + 24;
    const bottom = node.core ? point.y + 36 : point.y + 24;
    minX = Math.min(minX, left); maxX = Math.max(maxX, right);
    minY = Math.min(minY, point.y - 24); maxY = Math.max(maxY, bottom);
  }
  const availableW = Math.max(120, width - (compact ? 40 : 18));
  const availableH = Math.max(100, height - 16);
  const scale = Math.min(availableW / (maxX - minX), availableH / (maxY - minY), compact ? 1.16 : 1.35);
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const positions = new Map();
  for (const item of projected) {
    const x = width / 2 + (item.point.x - centerX) * scale * state.zoom;
    const y = height / 2 + (item.point.y - centerY) * scale * state.zoom;
    positions.set(item.node.id, {
      x, y, side: item.side, item: item.node,
      depthScale: clamp(item.point.depth, .84, 1.12),
    });
  }
  return positions;
}

const state = {
  selected: 'reading',
  records: [],
  zoom: 1,
  yaw: 0,
  pitch: 0,
  hover: null,
  positions: new Map(),
  compact: false,
  flash: null,
};
let refs = null;
let onSelect = () => {};
let drag = null;
let release = null;
let frame = 0;
let flashTimer = 0;
let mobileOpen = false;
let booted = false;

function wireSphere(core, radius) {
  const parallels = [-60, -30, 0, 30, 60].map(latitude => ({ latitude }));
  const meridians = [0, 36, 72, 108, 144].map(longitude => ({ longitude }));
  const paths = { near: '', far: '' };
  for (const gridLine of [...parallels, ...meridians]) {
    const points = Array.from({ length: 33 }, (_, index) => {
      const turn = index / 32 * Math.PI * 2;
      const latitude = gridLine.latitude === undefined ? turn : gridLine.latitude * Math.PI / 180;
      const longitude = gridLine.longitude === undefined ? turn : gridLine.longitude * Math.PI / 180;
      return project({
        x: radius * Math.cos(latitude) * Math.cos(longitude),
        y: radius * Math.sin(latitude),
        z: radius * Math.cos(latitude) * Math.sin(longitude),
      }, 24 + state.yaw, -18 + state.pitch);
    });
    let lastLayer = null;
    const coord = p => `${(core.x + p.x).toFixed(1)} ${(core.y + p.y).toFixed(1)}`;
    for (let index = 1; index < points.length; index++) {
      const previous = points[index - 1];
      const current = points[index];
      const layer = previous.depth + current.depth > 2 ? 'near' : 'far';
      if (layer !== lastLayer) paths[layer] += `M${coord(previous)}`;
      paths[layer] += `L${coord(current)}`;
      lastLayer = layer;
    }
  }
  return `<path class="orbit-mesh-back" d="${paths.far}"/><path class="orbit-mesh-front" d="${paths.near}"/>`;
}

function projectionPlane(width, height, core, radius) {
  const horizon = height * .51 + state.pitch * .85;
  const vanishingX = width / 2 + state.yaw * 4;
  const grid = [];
  for (let index = -12; index <= 12; index++) {
    const offset = index * width / 15;
    grid.push(`M${(vanishingX + offset * .12).toFixed(1)} ${horizon}L${(vanishingX + offset).toFixed(1)} ${height}`);
  }
  for (let index = 0; index < 12; index++) {
    const y = horizon + (height - horizon) * (index / 12) ** 1.9;
    grid.push(`M0 ${y.toFixed(1)}H${width}`);
  }
  const baseY = core.y + radius * .8;
  return `<path class="field-plane" d="${grid.join('')}"/>
    <ellipse class="projection-base" cx="${core.x}" cy="${baseY}" rx="${radius * 1.4}" ry="${radius * .25}"/>
    <ellipse class="projection-base-inner" cx="${core.x}" cy="${baseY}" rx="${radius * 1.15}" ry="${radius * .19}"/>`;
}

function sceneryHtml(width, height, positions) {
  const core = positions.get('reading') || { x: width / 2, y: height / 2 };
  const rx = Math.max(80, Math.min(width * .38, 375));
  const ry = Math.max(70, Math.min(height * .39, 190));
  const radius = Math.min(width, height) * .25;
  const ringCenter = `${core.x}px ${core.y}px`;
  let ticks = '';
  for (let index = 0; index < 28; index++) {
    const angle = (Math.PI * 2 * index) / 28;
    const x = core.x + Math.cos(angle) * rx;
    const y = core.y + Math.sin(angle) * ry;
    const length = index % 7 === 0 ? 7 : 3;
    ticks += `<line class="orbit-tick" x1="${x.toFixed(1)}" y1="${y.toFixed(1)}" x2="${(x - Math.cos(angle) * length).toFixed(1)}" y2="${(y - Math.sin(angle) * length).toFixed(1)}"/>`;
  }
  let seed = 29;
  let stars = '';
  for (let index = 0; index < 24; index++) {
    seed = (seed * 9301 + 49297) % 233280;
    const x = 12 + (seed / 233280) * (width - 24);
    seed = (seed * 9301 + 49297) % 233280;
    const y = 12 + (seed / 233280) * (height - 24);
    const radius = index % 6 === 0 ? 1.25 : .75;
    stars += `<circle class="orbit-star" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${radius}"/>`;
  }
  return `<defs><radialGradient id="commandCoreGlow"><stop offset="0" stop-color="#1c94a5" stop-opacity=".34"/><stop offset="1" stop-color="#1c94a5" stop-opacity="0"/></radialGradient>
    <linearGradient id="commandPlaneLight" x2="0" y2="1"><stop offset="0" stop-color="#53bed1" stop-opacity=".06"/><stop offset="1" stop-color="#65b1d3" stop-opacity=".3"/></linearGradient></defs>
    <g>
      ${projectionPlane(width, height, core, radius)}
      <circle class="core-glow" cx="${core.x}" cy="${core.y}" r="${radius * 1.75}"/>
      <ellipse class="orbit-ring" cx="${core.x}" cy="${core.y}" rx="${rx}" ry="${ry}"/>
      <ellipse class="orbit-ring is-mid" cx="${core.x}" cy="${core.y}" rx="${rx * .72}" ry="${ry * .7}"/>
      <ellipse class="orbit-ring is-far" cx="${core.x}" cy="${core.y}" rx="${rx * .74}" ry="${ry * .22}" transform="rotate(-21 ${core.x} ${core.y})"/>
      <path class="orbit-axis" d="M${core.x} ${Math.max(8, core.y - ry * 1.12)}V${Math.min(height - 8, core.y + ry * 1.12)}M${Math.max(8, core.x - rx * 1.08)} ${core.y}H${Math.min(width - 8, core.x + rx * 1.08)}"/>
      <g class="orbit-mesh">${wireSphere(core, radius)}</g>
      <circle class="orbit-instrument" cx="${core.x}" cy="${core.y}" r="${radius * 1.19}"/>
      <circle class="orbit-sweep" cx="${core.x}" cy="${core.y}" r="${radius * 1.19}" pathLength="100" style="transform-origin:${ringCenter}"/>
      ${ticks}
      ${stars}
    </g>`;
}

function nodeHtml(node, position, index) {
  const label = graphNodeLabel(node.id);
  const count = countFor(node.id, state.records);
  const classes = ['graph-node'];
  if (node.core) classes.push('core');
  if (node.peripheral) classes.push('peripheral');
  if (state.flash?.nodeId === node.id) classes.push('record-flash');
  const hidden = state.compact && !MOBILE_IDS.has(node.id);
  return `<button type="button" class="${classes.join(' ')}"
    data-node="${node.id}" data-side="${position.side}" data-mobile-primary="${Boolean(node.mobilePrimary)}"
    data-recorded="${count > 0}" aria-pressed="${state.selected === node.id}"${hidden ? ' hidden' : ''}
    style="left:${position.x.toFixed(2)}px;top:${position.y.toFixed(2)}px;--node-scale:${position.depthScale.toFixed(2)};--enter-delay:${Math.min(index * 28, 300)}ms;z-index:${Math.round(20 + position.depthScale * 10)}"
    aria-label="${escapeHtml(label)}，${count ? `本地记录 ${count} 次` : '暂无本地记录'}">
    <span class="node-marker" aria-hidden="true"><span class="node-dot"></span><span class="node-corners"><i></i><i></i><i></i><i></i></span></span>
    <span class="node-label">${escapeHtml(label)}${count ? `<em>${count} 次记录</em>` : ''}</span>
  </button>`;
}

function linkHtml(position, core) {
  const node = position.item;
  const midX = (core.x + position.x) / 2;
  const midY = (core.y + position.y) / 2;
  const dx = position.x - core.x;
  const dy = position.y - core.y;
  const bend = node.peripheral ? .13 : .07;
  const controlX = midX - dy * bend;
  const controlY = midY + dx * bend;
  const count = countFor(node.id, state.records);
  const classes = ['graph-link'];
  if (node.peripheral) classes.push('is-outer');
  if (count) classes.push('is-recorded');
  if (state.selected === node.id) classes.push('is-selected');
  if (state.hover === node.id) classes.push('is-hovered');
  if (state.flash?.nodeId === node.id) classes.push('is-pulsing');
  return `<path class="${classes.join(' ')}" data-link="${node.id}" d="M${core.x} ${core.y}Q${controlX} ${controlY} ${position.x} ${position.y}" pathLength="1" style="--enter-delay:${Math.min(80 + position.depthScale * 20, 160)}ms"/>`;
}

function mobileRowHtml(node) {
  const label = graphNodeLabel(node.id);
  const count = countFor(node.id, state.records);
  return `<button type="button" class="mobile-node-row" data-node="${node.id}"
    data-recorded="${count > 0}" aria-pressed="${state.selected === node.id}">
    <span>${escapeHtml(label)}<small>${node.peripheral ? ' · 外围模块' : count ? ' · 近 100 条内' : ' · 可练习'}</small></span>
    <b>${count ? `${count} 次` : '—'}</b>
  </button>`;
}

function updateMobileList() {
  refs.mobileList.innerHTML = GRAPH_NODES.map(mobileRowHtml).join('');
  refs.mobileList.hidden = !mobileOpen;
  refs.allNodes.setAttribute('aria-expanded', String(mobileOpen));
  refs.allNodeCount.textContent = String(GRAPH_NODES.length);
}

function renderGraph({ updateList = true } = {}) {
  if (!refs) return;
  const rect = refs.viewport.getBoundingClientRect();
  if (rect.width < 80 || rect.height < 80) return;
  const active = document.activeElement;
  const focusId = active?.dataset.node;
  const focusList = [refs.nodes, refs.mobileList].find(list => list.contains(active));
  state.compact = compactLayout.matches;
  state.positions = layoutNodes(rect.width, rect.height, state.compact);
  const core = state.positions.get('reading');
  refs.orbit.setAttribute('viewBox', `0 0 ${rect.width} ${rect.height}`);
  refs.scenery.innerHTML = sceneryHtml(rect.width, rect.height, state.positions);
  refs.links.innerHTML = GRAPH_NODES
    .filter(node => node.id !== 'reading' && state.positions.has(node.id))
    .map(node => linkHtml(state.positions.get(node.id), core))
    .join('');
  const ordered = [...state.positions.values()].sort((a, b) => a.depthScale - b.depthScale);
  const corePosition = state.positions.get('reading') || { x: rect.width / 2, y: rect.height / 2 };
  const offMap = state.compact
    ? GRAPH_NODES.filter(node => !state.positions.has(node.id))
      .map(node => ({ item: node, x: corePosition.x, y: corePosition.y, side: 'left', depthScale: 1 }))
    : [];
  refs.nodes.innerHTML = [...ordered, ...offMap].map((position, index) => nodeHtml(position.item, position, index)).join('');
  refs.stage.style.setProperty('--graph-zoom', state.zoom);
  const focus = state.selected !== 'reading' ? state.positions.get(state.selected) : null;
  const shiftX = focus ? rect.width / 2 - focus.x : 0;
  const shiftY = focus ? rect.height / 2 - focus.y : 0;
  refs.stage.style.transform = `translate3d(${shiftX.toFixed(2)}px, ${shiftY.toFixed(2)}px, 0)`;
  if (updateList) updateMobileList();
  updateReticle();
  bindNodeHover();
  if (focusList && focusId) {
    const button = focusList.querySelector('[data-node="' + CSS.escape(focusId) + '"]');
    if (button?.getClientRects().length) button.focus({ preventScroll: true });
  }
}

function bindNodeHover() {
  refs.nodes.querySelectorAll('.graph-node').forEach(button => {
    button.addEventListener('pointerenter', () => setHovered(button.dataset.node));
    button.addEventListener('pointerleave', () => setHovered(null));
    button.addEventListener('focus', () => setHovered(button.dataset.node));
    button.addEventListener('blur', () => setHovered(null));
  });
}

function updateReticle() {
  const id = state.hover || state.selected;
  const position = state.positions.get(id);
  if (!position) {
    refs.reticle.classList.remove('is-visible', 'is-locked');
    return;
  }
  refs.reticle.style.left = `${position.x.toFixed(2)}px`;
  refs.reticle.style.top = `${position.y.toFixed(2)}px`;
  refs.reticle.classList.add('is-visible');
  refs.reticle.classList.toggle('is-locked', !state.hover || state.hover === state.selected);
}

function setHovered(nodeId) {
  if (state.hover === nodeId) return;
  state.hover = nodeId;
  refs.links.querySelectorAll('[data-link]').forEach(path => {
    path.classList.toggle('is-hovered', path.dataset.link === nodeId);
  });
  updateReticle();
}

function stopRelease() {
  if (release?.frame) cancelAnimationFrame(release.frame);
  release = null;
}

function beginRelease(velocityYaw, velocityPitch) {
  stopRelease();
  const startYaw = state.yaw;
  const startPitch = state.pitch;
  const endYaw = clamp(startYaw + velocityYaw * 150, -18, 18);
  const endPitch = clamp(startPitch + velocityPitch * 120, -10, 10);
  const started = performance.now();
  const step = now => {
    const progress = Math.min(1, (now - started) / 220);
    const ease = 1 - (1 - progress) ** 3;
    state.yaw = startYaw + (endYaw - startYaw) * ease;
    state.pitch = startPitch + (endPitch - startPitch) * ease;
    renderGraph({ updateList: false });
    if (progress < 1) release = { frame: requestAnimationFrame(step) };
    else {
      release = null;
      refs.viewport.classList.remove('dragging');
    }
  };
  release = { frame: requestAnimationFrame(step) };
}

function scheduleRender() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    renderGraph({ updateList: false });
  });
}

function setSelected(nodeId) {
  state.selected = nodeId;
  if (!MOBILE_IDS.has(nodeId)) state.hover = null;
  renderGraph();
}

function setData({ selected, records }) {
  state.selected = selected;
  state.records = records;
  renderGraph();
}

function pulse(record) {
  const nodeId = record.kind === 'main' ? record.errorType : 'reading';
  state.flash = { nodeId };
  clearTimeout(flashTimer);
  renderGraph();
  flashTimer = setTimeout(() => {
    if (state.flash?.nodeId !== nodeId) return;
    state.flash = null;
    renderGraph();
  }, 850);
}

function setZoom(next) {
  state.zoom = clamp(next, .8, 1.35);
  renderGraph();
}

function resetView() {
  stopRelease();
  state.zoom = 1;
  state.yaw = 0;
  state.pitch = 0;
  state.hover = null;
  state.selected = 'reading';
  onSelect('reading');
  renderGraph();
}

function bootGraph() {
  if (booted) return;
  booted = true;
  const consoleEl = refs.viewport.closest('.command-console');
  consoleEl?.classList.add('is-booting');
  refs.viewport.classList.add('is-scanning');
  setTimeout(() => {
    consoleEl?.classList.remove('is-booting');
    refs.viewport.classList.remove('is-scanning');
  }, 520);
}

export function initCommandGraph({ onSelect: selectCallback }) {
  onSelect = selectCallback;
  refs = {
    viewport: document.getElementById('graphViewport'),
    stage: document.getElementById('graphStage'),
    orbit: document.getElementById('graphOrbit'),
    scenery: document.getElementById('graphScenery'),
    links: document.getElementById('graphLinkPaths'),
    nodes: document.getElementById('graphNodes'),
    reticle: document.getElementById('graphReticle'),
    mobileList: document.getElementById('commandMobileNodes'),
    allNodes: document.getElementById('commandAllNodes'),
    allNodeCount: document.getElementById('commandAllNodeCount'),
  };
  const select = event => {
    const button = event.target.closest('[data-node]');
    if (button) onSelect(button.dataset.node);
  };
  refs.nodes.addEventListener('click', select);
  refs.mobileList.addEventListener('click', select);
  refs.allNodes.addEventListener('click', () => {
    mobileOpen = !mobileOpen;
    updateMobileList();
  });
  document.getElementById('graphZoomIn').addEventListener('click', () => setZoom(state.zoom + .1));
  document.getElementById('graphZoomOut').addEventListener('click', () => setZoom(state.zoom - .1));
  document.getElementById('graphReset').addEventListener('click', resetView);

  refs.viewport.addEventListener('pointerdown', event => {
    if (event.target.closest('button') || event.button !== 0) return;
    stopRelease();
    state.hover = null;
    drag = {
      x: event.clientX, y: event.clientY, yaw: state.yaw, pitch: state.pitch,
      lastX: event.clientX, lastY: event.clientY, lastAt: performance.now(),
      lastYaw: state.yaw, lastPitch: state.pitch, vy: 0, vx: 0,
    };
    refs.viewport.setPointerCapture(event.pointerId);
    refs.viewport.classList.add('dragging');
  });
  refs.viewport.addEventListener('pointermove', event => {
    if (!drag) return;
    const now = performance.now();
    const dt = Math.max(8, now - drag.lastAt);
    state.yaw = clamp(drag.yaw + (event.clientX - drag.x) * .085, -18, 18);
    state.pitch = clamp(drag.pitch + (event.clientY - drag.y) * .06, -10, 10);
    drag.vy = (state.yaw - drag.lastYaw) / dt || 0;
    drag.vx = (state.pitch - drag.lastPitch) / dt || 0;
    drag.lastYaw = state.yaw;
    drag.lastPitch = state.pitch;
    drag.lastAt = now;
    scheduleRender();
  });
  const endDrag = () => {
    if (!drag) return;
    const velocityYaw = drag.vy || 0;
    const velocityPitch = drag.vx || 0;
    drag = null;
    if (reducedMotion.matches) refs.viewport.classList.remove('dragging');
    else beginRelease(velocityYaw, velocityPitch);
  };
  refs.viewport.addEventListener('pointerup', endDrag);
  refs.viewport.addEventListener('pointercancel', endDrag);

  const resizeObserver = new ResizeObserver(() => scheduleRender());
  resizeObserver.observe(refs.viewport);
  document.addEventListener('visibilitychange', () => {
    const consoleEl = refs.viewport.closest('.command-console');
    consoleEl?.classList.toggle('is-paused', document.hidden);
  });
  requestAnimationFrame(() => {
    renderGraph();
    bootGraph();
  });
  return { setData, setSelected, pulse, resetView, setZoom };
}



