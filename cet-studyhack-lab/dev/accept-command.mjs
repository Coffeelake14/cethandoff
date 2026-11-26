// Visual composition reference (layout only, no code reuse):
// cet-studyhack-command-edition/dev/acceptance/command-layers.png
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const base = process.env.CET_TEST_BASE || 'http://127.0.0.1:4318';
const outDir = resolve('dev/acceptance');
const chrome = process.env.CET_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const profile = mkdtempSync(join(tmpdir(), 'cet-command-acceptance-'));
const browser = spawn(chrome, [
  '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1440,1000', 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });

const checks = [];
const exceptions = [];
const check = (condition, name, detail = '') => {
  assert.ok(condition, `${name}${detail ? `: ${detail}` : ''}`);
  checks.push(name);
};

let ws;
let nextId = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolveSend, reject) => {
  const id = ++nextId;
  pending.set(id, { resolveSend, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
};
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
async function waitFor(expression, label) {
  for (let i = 0; i < 250; i++) {
    if (await evaluate(expression)) return;
    await delay(40);
  }
  const detail = await evaluate(`({url:location.href,ready:document.readyState,nodes:document.querySelectorAll('.graph-node').length,body:document.body?.innerText.slice(0,200)})`);
  throw new Error(`Timed out: ${label}: ${JSON.stringify(detail)} exceptions=${exceptions.join(';')}`);
}
async function navigate() {
  await send('Page.navigate', { url: base });
  await waitFor(`document.readyState !== 'loading' && document.querySelectorAll('.graph-node').length > 0`, 'app ready');
}
async function setViewport(width, height) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 768 });
  await delay(300);
}
async function click(selector) {
  await delay(100);
  await evaluate(`(() => {
    const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const el = nodes.find(node => node.getClientRects().length) || nodes[0];
    if (el) el.scrollIntoView({block:'center', inline:'center', behavior:'instant'});
  })()`);
  await delay(60);
  const point = await evaluate(`(() => {
    const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const el = nodes.find(node => node.getClientRects().length) || nodes[0];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {x:r.left+r.width/2,y:r.top+r.height/2};
  })()`);
  assert.ok(point, `Missing click target ${selector}`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  await delay(50);
}
async function key(keyName, code, keyCode) {
  const text = keyName === 'Enter' ? '\r' : undefined;
  const textFields = text ? { text, unmodifiedText: text } : {};
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: keyName, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, ...textFields });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
  await delay(50);
}
async function screenshot(name, fullPage = false) {
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: fullPage });
  const path = join(outDir, name);
  writeFileSync(path, Buffer.from(shot.data, 'base64'));
  return path;
}
async function screenshotClip(selector, name) {
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center', inline:'center', behavior:'instant'})`);
  await delay(320);
  const rect = await evaluate(`(() => {
    const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height };
  })()`);
  const shot = await send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: true,
    clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 },
  });
  const path = join(outDir, name);
  writeFileSync(path, Buffer.from(shot.data, 'base64'));
  return path;
}
const historyCount = () => evaluate(`Object.keys(localStorage).filter(k => k.startsWith('cet.command.history.v1.')).length`);
const metrics = () => evaluate(`[...document.querySelectorAll('.metric')].map(el => el.innerText.replace(/\\s+/g,' ').trim())`);

try {
  const endpoint = await new Promise((resolveEndpoint, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error('Chrome debug endpoint timeout')), 15000);
    browser.stderr.on('data', chunk => {
      text += chunk.toString();
      const match = text.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timer); resolveEndpoint(match[1]); }
    });
    browser.on('error', reject);
  });
  const targets = await (await fetch(`${endpoint.replace('ws://', 'http://').replace(/\/devtools\/browser\/.*$/, '')}/json/list`)).json();
  const page = targets.find(target => target.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolveOpen, rejectOpen) => { ws.onopen = resolveOpen; ws.onerror = rejectOpen; });
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const item = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) item.reject(new Error(message.error.message));
      else item.resolveSend(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') {
      exceptions.push(message.params.exceptionDetails.text);
    }
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await setViewport(1920, 1080);
  await navigate();
  await evaluate('localStorage.clear()');
  await navigate();

  check(await evaluate(`document.body.dataset.view === 'command' && document.body.dataset.mode === 'command'`), 'command center opens by default');
  check(await evaluate(`getComputedStyle(document.body).backgroundColor === 'rgb(20, 23, 26)' && getComputedStyle(document.querySelector('.command-console')).backgroundColor === 'rgb(29, 33, 38)'`), 'command center uses graphite mission surface');
  check(await evaluate(`getComputedStyle(document.querySelector('.command-primary')).backgroundColor === 'rgb(111, 227, 192)'`), 'command primary key uses mint accent');
  check(await evaluate(`!document.querySelector('.tabnav').getClientRects().length && !document.getElementById('view-reading').classList.contains('active') && !document.getElementById('view-estimator').classList.contains('active')`), 'simple-mode tabs stay out of command center');
  check(await evaluate(`(() => {
    const items = [...document.querySelectorAll('#commandRadar .radar-item')];
    return items.length === 5 && items.every(el => el.classList.contains('is-empty') && el.querySelector('.radar-item-value').textContent === '—' && el.querySelector('.radar-item-note').textContent === '无样本');
  })()`), 'empty radar separates no-sample axes');
  check(await evaluate(`document.querySelector('.command-performance').contains(document.getElementById('commandRadar'))`), 'radar lives in the left performance column');
  check(await evaluate(`(() => {
    const details = document.querySelector('.performance-stats');
    return details.open && details.contains(document.getElementById('commandMetrics')) && document.getElementById('commandMetrics').getClientRects().length > 0;
  })()`), 'performance stats stay collapsible and open by default');
  await click('.performance-stats summary');
  check(await evaluate(`!document.querySelector('.performance-stats').open`), 'performance stats collapse');
  await click('.performance-stats summary');
  check(await evaluate(`document.querySelector('.performance-stats').open`), 'performance stats reopen');
  check(await evaluate(`(() => {
    const labels = [...document.querySelectorAll('#graphNodes .node-label')].map(el => el.textContent);
    return labels.some(text => text.startsWith('阅读')) && labels.some(text => text.startsWith('听力'))
      && labels.some(text => text.startsWith('写作')) && labels.some(text => text.startsWith('翻译'))
      && !labels.some(text => /^(reading|listening|writing|translation)/.test(text));
  })()`), 'module node labels render in Chinese');
  check(await evaluate(`document.querySelectorAll('.machine-deck').length === 4 && document.querySelectorAll('.machine-deck .deck-wall').length > 0 && document.querySelectorAll('.machine-deck .deck-top').length === 4`), 'sandbox renders four decks with solid side walls');
  check((await metrics()).every(text => text.includes('—') && text.includes('待练习')), 'zero metrics show pending');
  check(await evaluate(`document.getElementById('commandLogs').innerText.includes('暂无练习记录')`), 'empty log state');
  check(await evaluate(`document.getElementById('commandMonitor').innerText.includes('完成一道阅读练习后')`), 'empty monitor state');
  check(await evaluate(`document.querySelectorAll('#graphNodes .graph-node').length === 13`), 'real error graph nodes');
  const desktopGraph = await evaluate(`(() => {
    const v = document.getElementById('graphViewport').getBoundingClientRect();
    const items = [...document.querySelectorAll('#graphNodes .graph-node')].filter(el => el.getClientRects().length).map(el => {
      const b = el.getBoundingClientRect();
      const l = el.querySelector('.node-label').getBoundingClientRect();
      return { id: el.dataset.node, left: Math.min(b.left,l.left), right: Math.max(b.right,l.right), top: Math.min(b.top,l.top), bottom: Math.max(b.bottom,l.bottom) };
    });
    return { viewport: { left: v.left, right: v.right, top: v.top, bottom: v.bottom }, items };
  })()`);
  check(desktopGraph.items.length === 13 && desktopGraph.items.every(item => item.left >= desktopGraph.viewport.left - 1 && item.right <= desktopGraph.viewport.right + 1 && item.top >= desktopGraph.viewport.top - 1 && item.bottom <= desktopGraph.viewport.bottom + 1), '1920 graph nodes and labels fit viewport', JSON.stringify(desktopGraph));
  await click('#commandReturn');
  check(await evaluate(`document.body.dataset.view === 'reading' && document.body.dataset.mode === 'simple' && document.querySelector('.tabnav').getClientRects().length > 0 && document.activeElement.id === 'tab-reading'`), 'return enters simple mode with learning tabs');
  check(await evaluate(`document.getElementById('tab-reading').getClientRects().length > 0 && document.getElementById('tab-estimator').getClientRects().length > 0 && document.getElementById('tab-command').innerText.includes('返回作战中心')`), 'simple mode owns lab, estimator and command re-entry');
  const simpleShot = await screenshot('simple-desktop.png');
  await click('#tab-command');
  check(await evaluate(`document.body.dataset.view === 'command' && document.body.dataset.mode === 'command' && !document.querySelector('.tabnav').getClientRects().length`), 'simple mode returns to command center');
  await click('[data-node="scope_expansion"]');
  check(await evaluate(`document.querySelector('#graphNodes [data-node=scope_expansion]').getAttribute('aria-pressed') === 'true'`), 'node selection works');
  check(await evaluate(`document.getElementById('commandNodeDetail').innerText.includes('屏幕阅读真的更差吗？')`), 'preset mapping appears');
  check(await evaluate(`document.getElementById('commandNodeDetail').querySelectorAll('.node-train').length === 1 && document.querySelectorAll('#commandContinue').length === 1`), 'preset keeps one goal-specific entry beside toolbar CTA');
  await click('[data-node="reading"]');
  check(await evaluate(`document.getElementById('commandNodeDetail').querySelectorAll('.node-train').length === 0`), 'generic node detail no longer duplicates practice entry');
  await click('[data-node="scope_expansion"]');
  await click('#commandNodeDetail [data-action="train"]');
  check(await evaluate(`document.body.dataset.view === 'reading' && document.activeElement.dataset.id === 'screen-reading'`), 'training opens and focuses matching material');

  await click('[data-key="A"]');
  await click('[data-sid="s5"]');
  await click('[data-act="submit"]');
  check(await evaluate(`JSON.parse(localStorage.getItem('cet.lab.v1')).screen === 'hint'`), 'first answer reaches hint');
  check(await historyCount() === 0, 'hint does not record history');
  await click('#tab-command');
  check(await historyCount() === 0, 'tab switching at hint does not record');
  await click('#commandReturn');
  check(await evaluate(`document.body.dataset.view === 'reading' && document.activeElement.id === 'tab-reading'`), 'return restores learning tab and focus');
  check(await evaluate(`Boolean(document.querySelector('.hint-text'))`), 'return preserves hint stage');

  await click('[data-act="reanswer"]');
  await click('[data-key="B"]');
  check(await evaluate(`document.querySelector('[data-sid=s5]').getAttribute('aria-pressed') === 'true'`), 'reanswer preserves selected evidence');
  await click('[data-act="submit"]');
  check(await evaluate(`document.getElementById('labStage').innerText.includes('范围扩大')`), 'public diagnosis shows scope expansion');
  check(await historyCount() === 1, 'main result records exactly once');
  await click('#tab-command');
  await waitFor(`document.querySelector('[data-node=scope_expansion].record-flash') && document.querySelector('[data-link=scope_expansion].is-pulsing')`, 'first record feedback');
  check(await evaluate(`document.querySelector('[data-node=scope_expansion]').getAttribute('aria-pressed') === 'true' && document.querySelector('.monitor-row.record-flash') && document.querySelector('.log-row.record-flash')`), 'first record locks node, monitor and log');
  check(JSON.stringify(await metrics()) === JSON.stringify([
    '首答正确 0/1 可判断主练习 · 样本 1',
    '首答证据对齐 1/1 可核对证据 · 样本 1',
    '重答修正 1/1 首答错误且已重答 · 样本 1',
    '同类题答对且依据对齐 — 待练习',
  ]), 'main result metrics match acceptance path');
  check(await evaluate(`(() => {
    const items = [...document.querySelectorAll('#commandRadar .radar-item')];
    const item = label => items.find(el => el.querySelector('.radar-item-label').textContent === label);
    return item('首答').querySelector('.radar-item-value').textContent === '0/1' && item('首答').className.includes('is-zero')
      && item('重答').querySelector('.radar-item-value').textContent === '1/1' && !item('重答').className.includes('is-zero')
      && item('同类答题').querySelector('.radar-item-value').textContent === '—' && item('同类答题').classList.contains('is-empty');
  })()`), 'radar distinguishes zero score from no samples');
  check(await evaluate(`document.querySelector('.monitor-count').textContent === '1' && document.querySelectorAll('.log-row').length === 1`), 'monitor and log update together');
  await delay(950);
  await click('#commandReturn');
  await click('#tab-command');
  check(await evaluate(`!document.querySelector('.record-flash') && !document.querySelector('.is-pulsing')`), 'first record feedback plays only once');

  await setViewport(1920, 1080);
  await evaluate('scrollTo(0,0)');
  await click('#graphReset');
  await delay(500);
  check(await evaluate(`getComputedStyle(document.querySelector('.command-grid')).gridTemplateColumns.split(' ').length === 3`), 'desktop uses three columns');
  const firstScreen = await evaluate(`(() => {
    const radar = document.getElementById('commandRadar').getBoundingClientRect();
    const panel = document.querySelector('.command-performance').getBoundingClientRect();
    return { h: innerHeight, top: radar.top, bottom: radar.bottom, left: radar.left, width: radar.width, panelWidth: panel.width };
  })()`);
  check(firstScreen.top > 0 && firstScreen.bottom < firstScreen.h && firstScreen.width >= firstScreen.panelWidth - 30, '1366 first screen shows radar in left column', JSON.stringify(firstScreen));
  const wideShot = await screenshot('command-wide.png');
  await setViewport(1366, 768);
  await evaluate('scrollTo(0,0)');
  await delay(500);
  const compactRects = await evaluate(`(() => {
    const rect = s => { const r=document.querySelector(s).getBoundingClientRect(); return {top:r.top,bottom:r.bottom,height:r.height,left:r.left,right:r.right}; };
    return {h:innerHeight, primary:rect('#commandContinue'), graph:rect('.command-graph-panel'), viewport:rect('.graph-viewport'), detail:rect('.node-detail'), returnButton:rect('#commandReturn'), train:[...document.querySelectorAll('.node-train')].map(el=>({text:el.innerText,bottom:el.getBoundingClientRect().bottom,visible:Boolean(el.getClientRects().length)}))};
  })()`);
  check(compactRects.primary.height >= 44 && compactRects.primary.height <= 48 && compactRects.primary.bottom < compactRects.h, '1366 main action is compact and above fold', JSON.stringify(compactRects));
  check(compactRects.returnButton.bottom < compactRects.h && compactRects.graph.bottom < compactRects.h && compactRects.viewport.height >= 420, '1366 shows complete graph, main action and mode switch', JSON.stringify(compactRects));
  const compactGraph = await evaluate(`(() => {
    const v = document.getElementById('graphViewport').getBoundingClientRect();
    const items = [...document.querySelectorAll('#graphNodes .graph-node')].filter(el => el.getClientRects().length).map(el => {
      const b = el.getBoundingClientRect(); const l = el.querySelector('.node-label').getBoundingClientRect();
      return { id: el.dataset.node, left: Math.min(b.left,l.left), right: Math.max(b.right,l.right), top: Math.min(b.top,l.top), bottom: Math.max(b.bottom,l.bottom) };
    });
    return { viewport: { left: v.left, right: v.right, top: v.top, bottom: v.bottom }, items };
  })()`);
  check(compactGraph.items.length === 13 && compactGraph.items.every(item => item.left >= compactGraph.viewport.left - 1 && item.right <= compactGraph.viewport.right + 1 && item.top >= compactGraph.viewport.top - 1 && item.bottom <= compactGraph.viewport.bottom + 1), '1366 graph nodes and labels fit viewport', JSON.stringify(compactGraph));
  const desktopShot = await screenshot('command-desktop.png');

  await click('#commandContinue');
  await click('[data-act="transfer"]');
  check(await evaluate(`document.getElementById('labStage').innerText.includes('咖啡与睡眠')`), 'transfer opens expected item');
  await click('[data-key="B"]');
  await click('[data-sid="s2"]');
  await click('[data-act="submit-transfer"]');
  check(await historyCount() === 2, 'transfer adds one independent record');
  await click('#tab-command');
  check((await metrics())[3].includes('1/1'), 'transfer metric is 1/1');
  check(await evaluate(`(() => {
    const items = [...document.querySelectorAll('#commandRadar .radar-item')];
    const value = label => items.find(el => el.querySelector('.radar-item-label').textContent === label)?.querySelector('.radar-item-value').textContent;
    return value('同类答题') === '1/1' && value('同类依据') === '1/1';
  })()`), 'radar transfer answer and evidence axes update');
  check(await evaluate(`document.querySelectorAll('.radar-pylon').length === 5 && document.querySelector('.radar-floor') && document.querySelector('.radar-floor-shape')`), 'radar renders extruded 3D pylons and floor');
  check(await evaluate(`document.querySelector('.monitor-count').textContent === '1'`), 'transfer does not inflate main error count');
  await click('#commandReturn');
  await click('[data-act="summary"]');
  await click('#tab-command');
  await click('#commandReturn');
  await click('#tab-command');
  check(await historyCount() === 2, 'summary and tab views do not duplicate records');
  await send('Page.reload', { ignoreCache: true });
  await waitFor(`document.readyState !== 'loading' && document.querySelectorAll('.graph-node').length > 0`, 'reload');
  check(await evaluate(`document.body.dataset.view === 'command' && document.body.dataset.mode === 'command'`), 'refresh returns to command center');
  check(await historyCount() === 2, 'refresh does not duplicate records');
  check(await evaluate(`!document.querySelector('.record-flash') && !document.querySelector('.is-pulsing')`), 'refresh does not replay record feedback');

  await click('#commandReturn');
  await click('#tab-estimator');
  await evaluate(`(() => { const input = document.querySelector('#est-listeningFields input'); input.value = '7'; input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await click('#tab-command');
  await click('#commandReturn');
  check(await evaluate(`document.body.dataset.view === 'estimator' && document.activeElement.id === 'tab-estimator' && document.querySelector('#est-listeningFields input').value === '7'`), 'estimator return preserves input');
  await click('#tab-command');
  await click('#commandReturn');
  await click('#tab-reading');
  await click('#subtab-tool');
  await evaluate(`(() => { const input = document.getElementById('toolInput'); input.value = 'Keep this reading draft.'; input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await delay(350);
  await click('#tab-command');
  await click('#commandReturn');
  check(await evaluate(`document.body.dataset.view === 'reading' && !document.getElementById('toolPanel').hidden && document.getElementById('toolInput').value === 'Keep this reading draft.'`), 'reading tool return preserves panel and input');
  await click('.skin-switch button[data-skin="tech"]');
  check(await evaluate(`document.body.dataset.skin === 'tech' && getComputedStyle(document.getElementById('instrTool')).display === 'flex' && document.getElementById('toolInput').value === 'Keep this reading draft.'`), 'skin switch keeps reading draft');
  check(await evaluate(`(() => {
    const labTop = getComputedStyle(document.querySelector('.lab-hero')).borderTopColor;
    const estTop = getComputedStyle(document.querySelector('.view-estimator .disclaimer-banner')).borderTopColor;
    const sparkHidden = getComputedStyle(document.querySelector('#labStartBtn svg')).display === 'none';
    return labTop === 'rgb(201, 138, 75)' && estTop === labTop && sparkHidden;
  })()`), 'tech pages share header accent and hide decorative spark icons');
  await click('.skin-switch button[data-skin="simple"]');
  check(await evaluate(`document.body.dataset.skin === 'simple' && getComputedStyle(document.getElementById('instrTool')).display === 'none' && document.getElementById('toolInput').value === 'Keep this reading draft.'`), 'return to simple keeps reading draft');

  await click('#tab-command');
  await evaluate(`(() => { const saved = JSON.parse(localStorage.getItem('cet.lab.v1')); delete saved.attemptId; localStorage.setItem('cet.lab.v1', JSON.stringify(saved)); })()`);
  await send('Page.reload', { ignoreCache: true });
  await waitFor(`document.readyState !== 'loading' && document.querySelectorAll('.graph-node').length > 0`, 'old draft restore');
  check(await historyCount() === 2, 'old draft restore is read-only');
  check(await evaluate(`JSON.parse(localStorage.getItem('cet.lab.v1')).attemptId == null`), 'old draft keeps missing id until submission');
  await click('#commandReturn');
  await click('#tab-reading');
  await evaluate(`(() => { const saved = JSON.parse(localStorage.getItem('cet.lab.v1')); saved.screen = 'hint'; saved.diagnosis = null; saved.awaiting = true; saved.draft = {choice:'A',evidence:['s5'],confidence:'medium'}; localStorage.setItem('cet.lab.v1', JSON.stringify(saved)); })()`);
  await send('Page.reload', { ignoreCache: true });
  await waitFor(`document.readyState !== 'loading' && document.querySelector('[data-act=reanswer]')`, 'old hint restore');
  await click('#commandReturn');
  await click('#subtab-lab');
  await click('[data-act="reveal"]');
  check(await historyCount() === 3, 'old draft gets id on real submission');
  check(await evaluate(`/^[a-zA-Z0-9-]{4,80}$/.test(JSON.parse(localStorage.getItem('cet.lab.v1')).attemptId)`), 'old draft receives valid attempt id');
  await click('#tab-command');
  check((await metrics())[2].includes('1/1'), 'new independent round keeps reanswer denominator at one');

  await setViewport(390, 844);
  await evaluate('scrollTo(0,0)');
  await click('#graphReset');
  await delay(350);
  check(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), '390px has no page horizontal overflow');
  check(await evaluate(`document.querySelector('.graph-viewport').getBoundingClientRect().height >= 290 && document.querySelector('.graph-viewport').getBoundingClientRect().height <= 310`), '390 graph keeps compact working height');
  check(await evaluate(`document.querySelectorAll('#graphNodes .graph-node').length === 13 && [...document.querySelectorAll('#graphNodes .graph-node')].filter(el => el.getClientRects().length).length === 4`), '390 graph shows core and three main causes');
  const mobileGraph = await evaluate(`(() => {
    const v = document.getElementById('graphViewport').getBoundingClientRect();
    const items = [...document.querySelectorAll('#graphNodes .graph-node')].filter(el => el.getClientRects().length).map(el => {
      const b = el.getBoundingClientRect(); const l = el.querySelector('.node-label').getBoundingClientRect();
      return { id: el.dataset.node, left: Math.min(b.left,l.left), right: Math.max(b.right,l.right), top: Math.min(b.top,l.top), bottom: Math.max(b.bottom,l.bottom) };
    });
    return { viewport: { left: v.left, right: v.right, top: v.top, bottom: v.bottom }, ids: items.map(item => item.id).sort(), items };
  })()`);
  check(JSON.stringify(mobileGraph.ids) === JSON.stringify(['attitude_shift','causal_inversion','reading','scope_expansion']) && mobileGraph.items.every(item => item.left >= mobileGraph.viewport.left - 1 && item.right <= mobileGraph.viewport.right + 1 && item.top >= mobileGraph.viewport.top - 1 && item.bottom <= mobileGraph.viewport.bottom + 1), '390 graph labels stay inside viewport', JSON.stringify(mobileGraph));
  check(await evaluate(`document.getElementById('commandMobileNodes').hidden && document.getElementById('commandAllNodes').getAttribute('aria-expanded') === 'false'`), '390 extra causes start collapsed');
  const mobileShot = await screenshot('command-mobile.png');
  check(await evaluate(`(() => {
    const panel = document.querySelector('.command-performance').getBoundingClientRect();
    const radar = document.getElementById('commandRadar').getBoundingClientRect();
    return panel.width > innerWidth * 0.85 && radar.width >= panel.width - 34 && radar.left >= -1 && radar.right <= innerWidth + 1;
  })()`), '390 radar keeps single-column reachable layout');
  check(await evaluate(`document.querySelector('.command-performance').getBoundingClientRect().top < document.querySelector('.command-side').getBoundingClientRect().top`), '390 radar precedes detail column');
  const radarShot = await screenshotClip('#commandRadar', 'command-radar.png');
  await evaluate('scrollTo(0,0)');
  await click('#commandAllNodes');
  const mobileHeights = await evaluate(`[...document.querySelectorAll('#commandMobileNodes .mobile-node-row')].map(el=>({text:el.innerText,h:el.getBoundingClientRect().height,display:getComputedStyle(el).display}))`);
  check(await evaluate(`!document.getElementById('commandMobileNodes').hidden && document.getElementById('commandAllNodes').getAttribute('aria-expanded') === 'true' && document.querySelectorAll('#commandMobileNodes .mobile-node-row').length === 13`), '390 all-causes list expands');
  check(mobileHeights.every(row => row.h >= 44), '390 all-causes rows meet touch height', JSON.stringify(mobileHeights));
  await click('#commandMobileNodes [data-node="detail_mismatch"]');
  const mobileDetail = await evaluate(`document.getElementById('commandNodeDetail').innerText`);
  check(await evaluate(`document.querySelector('#commandMobileNodes [data-node=detail_mismatch]').getAttribute('aria-pressed') === 'true' && document.querySelector('#graphNodes [data-node=detail_mismatch]').getAttribute('aria-pressed') === 'true' && document.getElementById('commandNodeDetail').innerText.includes('细节错配')`), 'mobile list shares selection with graph', mobileDetail);
  await setViewport(320, 720);
  check(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), '320px has no page horizontal overflow');
  const narrowButtons = await evaluate(`[...document.querySelectorAll('.mobile-node-row, .mobile-node-bar button, .graph-controls button, #commandReturn, #commandContinue, .node-train, .monitor-row, #commandShowAll')].filter(el => el.getClientRects().length).map(el=>{const r=el.getBoundingClientRect();return {text:el.innerText,left:r.left,right:r.right};})`);
  check(narrowButtons.every(rect => rect.left >= -1 && rect.right <= 321), '320px visible controls stay within page', JSON.stringify(narrowButtons.filter(rect => rect.left < -1 || rect.right > 321)));

  await setViewport(1366, 768);
  await evaluate('scrollTo(0,0)');
  check(await evaluate(`document.body.dataset.mode === 'command' && !document.querySelector('.tabnav').getClientRects().length`), 'wide command center keeps simple tabs hidden');
  await click('#commandReturn');
  check(await evaluate(`document.body.dataset.mode === 'simple' && document.querySelector('.tabnav').getClientRects().length > 0`), 'wide return reveals simple mode');
  await evaluate(`document.getElementById('tab-command').focus()`);
  await key('ArrowRight', 'ArrowRight', 39);
  check(await evaluate(`document.body.dataset.view === 'reading' && document.activeElement.id === 'tab-reading'`), 'tab arrow key wraps and moves focus');
  await click('#tab-command');
  check(await evaluate(`document.body.dataset.mode === 'command' && !document.querySelector('.tabnav').getClientRects().length`), 'command tab returns from simple mode');
  await click('#graphZoomIn');
  check(await evaluate(`document.getElementById('graphStage').style.getPropertyValue('--graph-zoom') === '1.1'`), 'graph zoom control works');
  await click('#graphReset');
  await delay(350);
  check(await evaluate(`document.getElementById('graphStage').style.getPropertyValue('--graph-zoom') === '1'`), 'graph reset works');
  check(await evaluate(`document.getElementById('graphBaseExpand').getAttribute('aria-pressed') === 'true' && document.querySelectorAll('.machine-deck').length === 4`), '3D machine deck starts expanded');
  const expandedDeckPoints = await evaluate(`document.querySelector('.machine-deck.deck-glass .deck-top').getAttribute('points')`);
  await click('#graphBaseCollapse');
  await delay(450);
  const collapsedDeckPoints = await evaluate(`document.querySelector('.machine-deck.deck-glass .deck-top').getAttribute('points')`);
  check(collapsedDeckPoints !== expandedDeckPoints && await evaluate(`document.getElementById('graphBaseCollapse').getAttribute('aria-pressed') === 'true'`), '3D machine deck collapses');
  await click('#graphBaseExpand');
  await delay(450);
  check(await evaluate(`document.getElementById('graphBaseExpand').getAttribute('aria-pressed') === 'true' && document.querySelector('.machine-deck.deck-glass .deck-top').getAttribute('points') !== ${JSON.stringify(collapsedDeckPoints)}`), '3D machine deck expands again');
  const scopePoint = await evaluate(`(() => { const r=document.querySelector('[data-node=scope_expansion]').getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...scopePoint });
  await delay(120);
  check(await evaluate(`document.getElementById('graphReticle').classList.contains('is-visible') && !document.getElementById('graphReticle').classList.contains('is-locked') && document.querySelector('[data-link=scope_expansion]').classList.contains('is-hovered')`), 'hover shows reticle and highlighted leader');
  await click('[data-node="scope_expansion"]');
  await delay(380);
  const focusedReticle = await evaluate(`(() => {
    const v=document.getElementById('graphViewport').getBoundingClientRect();
    const n=document.querySelector('[data-node=scope_expansion]').getBoundingClientRect();
    return {dx:Math.abs((n.left+n.width/2)-(v.left+v.width/2)),dy:Math.abs((n.top+n.height/2)-(v.top+v.height/2)),locked:document.getElementById('graphReticle').classList.contains('is-locked'),selected:document.querySelector('[data-link=scope_expansion]').classList.contains('is-selected')};
  })()`);
  check(focusedReticle.locked && focusedReticle.selected && focusedReticle.dx < 2 && focusedReticle.dy < 2, 'selection locks and centers target', JSON.stringify(focusedReticle));
  await click('#graphReset');
  await delay(350);
  await evaluate(`document.querySelector('[data-node=causal_inversion]').focus()`);
  await key('Enter', 'Enter', 13);
  check(await evaluate(`document.querySelector('[data-node=causal_inversion]').getAttribute('aria-pressed') === 'true'`), 'keyboard Enter selects graph node');
  await click('#graphReset');
  await delay(350);
  const beforeDrag = await evaluate(`(() => { const p=s=>{const r=document.querySelector(s).getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};}; return {near:p('[data-node=attitude_shift]'),far:p('[data-node=causal_inversion]'),deck:document.querySelector('.machine-deck.deck-glass .deck-top').getAttribute('points')}; })()`);
  const dragStart = await evaluate(`(() => {
    const r = document.getElementById('graphViewport').getBoundingClientRect();
    const x = r.left + 24, y = r.top + 24;
    return { x, y, blank: !document.elementFromPoint(x, y)?.closest('button') };
  })()`);
  check(dragStart.blank, 'graph drag starts in blank area');
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dragStart.x, y: dragStart.y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: dragStart.x, y: dragStart.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dragStart.x + 120, y: dragStart.y + 30, button: 'left' });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dragStart.x + 120, y: dragStart.y + 30, button: 'left', clickCount: 1 });
  await delay(380);
  const afterDrag = await evaluate(`(() => { const p=s=>{const r=document.querySelector(s).getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};}; return {near:p('[data-node=attitude_shift]'),far:p('[data-node=causal_inversion]')}; })()`);
  const nearMove = Math.hypot(afterDrag.near.x - beforeDrag.near.x, afterDrag.near.y - beforeDrag.near.y);
  const farMove = Math.hypot(afterDrag.far.x - beforeDrag.far.x, afterDrag.far.y - beforeDrag.far.y);
  check(nearMove > 1 && farMove > 1 && Math.abs(nearMove - farMove) > 2, 'drag gives near and far nodes different motion', JSON.stringify({nearMove,farMove,beforeDrag,afterDrag}));
  check(await evaluate(`document.querySelector('.machine-deck.deck-glass .deck-top').getAttribute('points') !== ${JSON.stringify(beforeDrag.deck)}`), '3D machine deck tilts with drag');
  await click('#graphReset');
  await delay(350);
  const afterReset = await evaluate(`(() => { const p=s=>{const r=document.querySelector(s).getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};}; return {near:p('[data-node=attitude_shift]'),far:p('[data-node=causal_inversion]'),selected:document.querySelector('[data-node=reading]').getAttribute('aria-pressed'),transform:document.getElementById('graphStage').style.transform}; })()`);
  check(afterReset.selected === 'true' && Math.abs(afterReset.near.x - beforeDrag.near.x) < 1.5 && Math.abs(afterReset.far.y - beforeDrag.far.y) < 1.5, 'graph reset restores default projection', JSON.stringify(afterReset));
  check(await evaluate(`document.getElementById('graphBaseExpand').getAttribute('aria-pressed') === 'true' && document.querySelector('.machine-deck.deck-glass .deck-top').getAttribute('points') === ${JSON.stringify(expandedDeckPoints)}`), 'graph reset restores expanded 3D machine deck');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  check(await evaluate(`getComputedStyle(document.querySelector('.graph-node')).animationName === 'none' && getComputedStyle(document.querySelector('.graph-node')).transitionDuration === '0s'`), 'reduced motion removes graph animation');
  check(await evaluate(`getComputedStyle(document.querySelector('.orbit-sweep')).animationName === 'none' && getComputedStyle(document.querySelector('.machine-deck')).transitionDuration === '0s'`), 'reduced motion stops 3D sandbox animation');
  check(exceptions.length === 0, 'no browser runtime exceptions', exceptions.join('; '));

  console.log(JSON.stringify({ status: 'PASS', checks: checks.length, wideShot, desktopShot, simpleShot, mobileShot, radarShot, exceptions }, null, 2));
} finally {
  ws?.close();
  browser.kill();
  await delay(150);
  rmSync(profile, { recursive: true, force: true });
}
