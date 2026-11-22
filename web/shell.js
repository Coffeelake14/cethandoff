// Shared shell for the CET StudyHack app: tab navigation between the reading
// lab and the reference estimator, plus toast / service-status helpers and the
// single health probe. Feature modules import toast, setStatus and
// getServiceMode from here so the header pill and toasts stay unified and the
// UI can clearly distinguish real AI from the local fixture mode.

const $ = id => document.getElementById(id);

const TABS = [
  { key: 'reading', tab: 'tab-reading', view: 'view-reading', title: '四六级阅读错因实验室 · StudyHack' },
  { key: 'estimator', tab: 'tab-estimator', view: 'view-estimator', title: '四六级参考估分 · StudyHack' },
];

let serviceMode = 'local';
export function getServiceMode() { return serviceMode; }

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

function showTab(key, persist = true) {
  const active = TABS.find(t => t.key === key) || TABS[0];
  for (const t of TABS) {
    const on = t.key === active.key;
    $(t.tab).setAttribute('aria-selected', String(on));
    $(t.tab).tabIndex = on ? 0 : -1;
    $(t.view).classList.toggle('active', on);
  }
  document.title = active.title;
  if (persist) { try { localStorage.setItem('cet.tab', active.key); } catch { /* ignore */ } }
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
  try { const s = localStorage.getItem('cet.tab'); if (s === 'estimator') saved = 'estimator'; } catch { /* ignore */ }
  showTab(saved, false);

  fetch('/functions/v1/app?action=health', { credentials: 'same-origin' })
    .then(r => r.ok ? r.json() : Promise.reject(new Error('bad status')))
    .then(d => {
      if (d && d.ok) {
        serviceMode = d.mode === 'live' ? 'live' : 'local';
        setStatus(serviceMode === 'live' ? 'ready' : 'local', serviceMode === 'live' ? '真实 AI 就绪' : '本地示例模式');
      } else {
        serviceMode = 'down';
        setStatus('down', '服务异常');
      }
    })
    .catch(() => { serviceMode = 'down'; setStatus('down', '服务离线'); });
}
