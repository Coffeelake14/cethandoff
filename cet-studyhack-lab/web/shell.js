const $ = id => document.getElementById(id);

const TABS = [
  { key: 'reading', tab: 'tab-reading', view: 'view-reading', title: '四六级阅读错因实验室 · StudyHack' },
  { key: 'estimator', tab: 'tab-estimator', view: 'view-estimator', title: '四六级参考估分 · StudyHack' },
  { key: 'command', tab: 'tab-command', view: 'view-command', title: 'CET 作战中心 · StudyHack' },
];

const FEATURE_NAMES = ['train', 'explain', 'grade', 'recommend', 'scan'];
const listeners = new Set();
let capabilities = { status: 'unknown', features: Object.fromEntries(FEATURE_NAMES.map(name => [name, false])) };
let requiresVisitor = false;
let capabilitiesPromise = null;
let connected = false;

function notifyCapabilities() {
  const snapshot = getCapabilities();
  for (const listener of listeners) {
    try { listener(snapshot); } catch {}
  }
}

export function getCapabilities() {
  return { status: capabilities.status, features: { ...capabilities.features } };
}

export function isFeatureEnabled(name) {
  return capabilities.status === 'ready' && capabilities.features[name] === true;
}

export function onCapabilities(listener) {
  listeners.add(listener);
  listener(getCapabilities());
  return () => listeners.delete(listener);
}

async function issueVisitor() {
  const res = await fetch('/functions/v1/app?action=visitor', {
    method: 'POST', credentials: 'same-origin', cache: 'no-store',
  });
  if (!res.ok) {
    const error = new Error('暂不可用，请重试。');
    error.code = 'capability_unavailable';
    throw error;
  }
}

export async function refreshCapabilities() {
  if (capabilitiesPromise) return capabilitiesPromise;
  capabilitiesPromise = (async () => {
    capabilities = { status: 'loading', features: { ...capabilities.features } };
    notifyCapabilities();
    try {
      const res = await fetch('/functions/v1/app?action=capabilities', {
        method: 'GET', credentials: 'same-origin', cache: 'no-store',
      });
      if (!res.ok) throw new Error('capabilities_unavailable');
      const data = await res.json();
      const features = data?.features;
      if (!features || typeof features !== 'object' || Array.isArray(features)) throw new Error('capabilities_invalid');
      requiresVisitor = data.requiresVisitor === true;
      capabilities = {
        status: 'ready',
        features: Object.fromEntries(FEATURE_NAMES.map(name => [name, features[name] === true])),
      };
    } catch {
      capabilities = { status: 'unknown', features: { ...capabilities.features } };
    } finally {
      capabilitiesPromise = null;
      notifyCapabilities();
    }
    return getCapabilities();
  })();
  return capabilitiesPromise;
}

export async function requireFeature(name) {
  const current = getCapabilities();
  if (current.status !== 'ready' || !current.features[name]) await refreshCapabilities();
  if (!isFeatureEnabled(name)) {
    const error = new Error('暂不可用，请重试。');
    error.code = 'capability_unavailable';
    throw error;
  }
  if (requiresVisitor) await issueVisitor();
  return true;
}

const UNAVAILABLE_CODES = new Set([
  'ai_not_configured', 'ai_access_denied', 'ai_rate_limited', 'ai_conflict',
  'ai_initialization_conflict', 'ai_resource_repair_required', 'ai_initialization_pending',
  'ai_initialization_rejected', 'ai_service_unavailable', 'ai_request_unknown',
  'ai_response_invalid', 'ai_empty_result', 'ai_quota_exceeded', 'ai_generation_failed',
  'ai_terminated', 'ai_incomplete', 'ai_timeout', 'ai_feature_unavailable',
  'ai_quota_unavailable', 'ai_visitor_quota_exceeded', 'ai_budget_blocked',
  'ai_issue_rate_limited', 'visitor_required', 'forbidden_origin',
]);

export function aiErrorMessage(error, fallback = '暂不可用，请重试。') {
  const code = String(error?.code || error?.message || '');
  if (code === 'capability_unavailable' || code.startsWith('sse_') || UNAVAILABLE_CODES.has(code)) return fallback;
  if (error?.name === 'TypeError' || error?.name === 'AbortError') return fallback;
  return error?.message || fallback;
}

export function toast(message, kind = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<svg><use href="#${kind === 'err' ? 'i-alert' : 'i-ok'}"/></svg><span></span>`;
  el.querySelector('span').textContent = message;
  $('toastRegion').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 240); }, 2800);
}

export function setStatus(state, text) {
  $('statusPill').dataset.state = state;
  $('statusText').textContent = text;
}

let activeTab = 'command';
let returnTab = 'reading';
let skin = 'simple';

const SKIN_LABELS = { simple: '简约模式', tech: '科技模式' };

function syncBrandSub() {
  $('brandSub').textContent = document.body.dataset.mode === 'command'
    ? 'CET 作战中心 · 本机学习数据'
    : `${SKIN_LABELS[skin]} · 错因实验室 / 参考估分`;
}

export function currentTab() {
  return activeTab;
}

export function currentSkin() {
  return skin;
}

export function setSkin(next, persist = true) {
  skin = next === 'tech' ? 'tech' : 'simple';
  document.body.dataset.skin = skin;
  document.querySelectorAll('.skin-switch button').forEach(btn => {
    btn.setAttribute('aria-pressed', String(btn.dataset.skin === skin));
  });
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', skin === 'tech' ? '#14171a' : '#2563eb');
  syncBrandSub();
  if (persist) {
    try { localStorage.setItem('cet.skin', skin); } catch {}
  }
  window.dispatchEvent(new CustomEvent('cet:skinchange', { detail: { skin } }));
}

export function showTab(key, persist = true) {
  const active = TABS.find(t => t.key === key) || TABS.find(t => t.key === 'command');
  const previous = activeTab;
  activeTab = active.key;
  if (active.key === 'command' && previous !== 'command') returnTab = previous === 'estimator' ? 'estimator' : 'reading';
  for (const t of TABS) {
    const on = t.key === active.key;
    $(t.tab).setAttribute('aria-selected', String(on));
    $(t.tab).tabIndex = on ? 0 : -1;
    $(t.view).classList.toggle('active', on);
  }
  const mode = active.key === 'command' ? 'command' : 'simple';
  document.body.dataset.view = active.key;
  document.body.dataset.mode = mode;
  $('commandReturn').hidden = mode !== 'command';
  document.title = active.title;
  syncBrandSub();
  if (active.key !== 'command' && persist) {
    try { localStorage.setItem('cet.tab', active.key); } catch {}
  }
  window.dispatchEvent(new CustomEvent('cet:viewchange', { detail: { key: active.key, previous, returnTab, mode } }));
}

export function returnToLearning() {
  showTab(returnTab);
  $(returnTab === 'estimator' ? 'tab-estimator' : 'tab-reading')?.focus();
}

export function openEstimator() {
  showTab('estimator');
  $('tab-estimator')?.focus();
}

async function probeHealth() {
  try {
    const res = await fetch('/functions/v1/app?action=health', { credentials: 'same-origin', cache: 'no-store' });
    if (!res.ok) throw new Error('health_unavailable');
    const data = await res.json();
    connected = Boolean(data?.ok);
  } catch {
    connected = false;
  }
  setStatus(connected ? 'ready' : 'down', connected ? '已连接' : '服务离线');
}

export function initShell() {
  for (const t of TABS) {
    $(t.tab).addEventListener('click', () => showTab(t.key));
    $(t.tab).addEventListener('keydown', e => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault();
      const idx = TABS.findIndex(x => x.key === t.key);
      const next = TABS[(idx + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
      showTab(next.key);
      $(next.tab).focus();
    });
  }
  let saved = 'reading';
  try { const s = localStorage.getItem('cet.tab'); if (s === 'estimator') saved = 'estimator'; } catch {}
  returnTab = saved;
  document.querySelectorAll('.skin-switch button').forEach(btn => {
    btn.addEventListener('click', () => setSkin(btn.dataset.skin));
  });
  let savedSkin = 'simple';
  try { if (localStorage.getItem('cet.skin') === 'tech') savedSkin = 'tech'; } catch {}
  setSkin(savedSkin, false);
  showTab('command', false);
  void probeHealth();
  void refreshCapabilities();
}
