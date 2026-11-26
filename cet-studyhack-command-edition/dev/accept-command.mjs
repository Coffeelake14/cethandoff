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
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: keyName, code, windowsVirtualKeyCode: keyCode, ...(keyName === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}) });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code, windowsVirtualKeyCode: keyCode });
  await delay(50);
}
async function screenshot(name, fullPage = false) {
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: fullPage });
  const path = join(outDir, name);
  writeFileSync(path, Buffer.from(shot.data, 'base64'));
  return path;
}
const historyCount = () => evaluate(`Object.keys(localStorage).filter(k => k.startsWith('cet.command.history.v1.')).length`);
const metrics = () => evaluate(`[...document.querySelectorAll('.metric')].map(el => el.textContent.replace(/\\s+/g,' ').trim())`);
const radarValues = () => evaluate(`[...document.querySelectorAll('#commandRadar .radar-axis b')].map(el => el.textContent)`);

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
  check(await evaluate(`getComputedStyle(document.querySelector('.bg')).backgroundColor === 'rgb(18, 21, 19)' && getComputedStyle(document.querySelector('.command-console')).backgroundColor === 'rgb(32, 35, 34)'`), 'command center uses dark graphite surfaces');
  check(await evaluate(`document.querySelector('.tabnav').getClientRects().length > 0 && document.getElementById('tab-command').getAttribute('aria-selected') === 'true' && !document.getElementById('view-reading').classList.contains('active') && !document.getElementById('view-estimator').classList.contains('active')`), 'command center provides navigation to the other stations');
  check((await metrics()).every(text => text.includes('—') && text.includes('待练习')), 'zero metrics show pending');
  check(JSON.stringify(await radarValues()) === JSON.stringify(['—', '—', '—', '—', '—']) && await evaluate(`document.querySelectorAll('#commandRadar .radar-point.is-pending').length === 5 && !document.querySelector('#commandRadar .radar-shape')`), 'five radar axes distinguish missing samples');
  check(await evaluate(`Boolean(document.querySelector('.field-plane') && document.querySelector('.orbit-mesh-front') && document.querySelector('.orbit-mesh-back'))`), 'field renders projection grid and distinct front and back meshes');
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
  check(await evaluate(`document.body.dataset.view === 'command' && document.body.dataset.mode === 'command'`), 'simple mode returns to command center');
  await click('[data-node="scope_expansion"]');
  check(await evaluate(`document.querySelector('#graphNodes [data-node=scope_expansion]').getAttribute('aria-pressed') === 'true'`), 'node selection works');
  check(await evaluate(`document.getElementById('commandNodeDetail').innerText.includes('屏幕阅读真的更差吗？')`), 'preset mapping appears');
  await click('#commandNodeDetail [data-action="train"]');
  check(await evaluate(`document.body.dataset.view === 'reading' && document.body.dataset.mode === 'command' && document.activeElement.dataset.id === 'screen-reading' && document.querySelectorAll('[data-instrument=evidence] .instrument-slab').length === 4`), 'training opens in the 3D workbench and focuses matching material');

  await click('[data-key="A"]');
  await click('[data-sid="s5"]');
  await click('#commandReturn');
  check(await evaluate(`document.body.dataset.mode === 'simple' && document.body.dataset.view === 'reading' && !document.querySelector('[data-instrument=evidence]').getClientRects().length && document.querySelector('[data-sid=s5]').getAttribute('aria-pressed') === 'true'`), 'simple mode preserves live evidence selection');
  await click('#commandReturn');
  check(await evaluate(`document.body.dataset.mode === 'command' && document.body.dataset.view === 'reading' && document.querySelector('[data-key=A]').getAttribute('aria-pressed') === 'true'`), 'returning to 3D keeps the selected answer');
  const labShot = await screenshot('workbench-lab.png');
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
  check(await evaluate(`document.querySelector('.monitor-count').textContent === '1' && document.querySelectorAll('.log-row').length === 1`), 'monitor and log update together');
  check(JSON.stringify(await radarValues()) === JSON.stringify(['0/1', '1/1', '1/1', '—', '—']), 'main practice updates real radar axes including measured zero');
  await evaluate(`document.querySelector('#commandRadar [data-axis=evidence].radar-axis').focus()`);
  await key('Enter', 'Enter', 13);
  check(await evaluate(`document.querySelector('#commandRadar [data-axis=evidence].radar-axis').getAttribute('aria-pressed') === 'true' && document.querySelector('#commandRadar .radar-caption').textContent === '首答依据对齐' && document.querySelector('#commandRadar .radar-value').textContent === '1 / 1'`), 'radar axis can be selected and inspected from the keyboard');
  await delay(950);
  await click('#commandReturn');
  await click('#tab-command');
  check(await evaluate(`!document.querySelector('.record-flash') && !document.querySelector('.is-pulsing')`), 'first record feedback plays only once');

  await setViewport(1920, 1080);
  await evaluate('scrollTo(0,0)');
  await click('#graphReset');
  await delay(500);
  check(await evaluate(`getComputedStyle(document.querySelector('.command-grid')).gridTemplateColumns.split(' ').length === 3`), 'desktop uses three columns');
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
  check(JSON.stringify(await radarValues()) === JSON.stringify(['0/1', '1/1', '1/1', '1/1', '1/1']) && await evaluate(`Boolean(document.querySelector('#commandRadar .radar-shape'))`), 'transfer answer and evidence complete the measured radar');
  await evaluate(`scrollTo({top:0,behavior:'instant'})`);
  await delay(900);
  const radarShot = await screenshot('command-radar.png');
  const deckTop = () => evaluate(`document.querySelector('.deck-glass .deck-top').getBoundingClientRect().top`);
  const assembled = await deckTop();
  await click('#graphLayers');
  await delay(410);
  check(await evaluate(`document.querySelectorAll('.machine-deck').length === 4 && document.getElementById('graphLayers').getAttribute('aria-pressed') === 'true'`) && (await deckTop()) < assembled - 25, 'the section view lifts the upper decks');
  await evaluate(`scrollTo({top:0,behavior:'instant'})`);
  const layersShot = await screenshot('command-layers.png');
  await click('#graphReset');
  check(Math.abs((await deckTop()) - assembled) < 2 && await evaluate(`document.getElementById('graphLayers').getAttribute('aria-pressed') === 'false'`), 'reset restores the assembled deck');
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
  await click('#commandReturn');
  check(await evaluate(`document.body.dataset.mode === 'command' && document.querySelector('[data-instrument=optics]').getClientRects().length > 0 && document.getElementById('toolInput').value === 'Keep this reading draft.'`), 'reading tools enter 3D without replacing the draft');
  if (process.env.CET_TEST_FIXTURES === '1') {
    await click('#toolSampleBtn');
    for (const [button, section] of [['Trans', 'translation'], ['Vocab', 'vocab'], ['Grammar', 'grammar']]) {
      await click(`#tool${button}Btn`);
      await waitFor(`document.getElementById('tool-status-${section}').dataset.state === 'done'`, `reading tools fixture for ${section}`);
      check(await evaluate(`document.getElementById('tool-sec-${section}').classList.contains('show')`), `${section} opens its 3D output panel`);
    }
    check(await evaluate(`!document.getElementById('toolExportBtn').disabled`), '3D vocabulary output retains dictation export');
    await evaluate(`scrollTo({top:0,behavior:'instant'})`);
  }
  const toolShot = await screenshot('workbench-tools.png');
  await click('#tab-estimator');
  await click('#est-estimateBtn');
  await waitFor(`document.getElementById('est-overviewCard').classList.contains('show')`, 'estimate result');
  check(await evaluate(`document.body.dataset.mode === 'command' && parseFloat(document.getElementById('est-scoreDial').style.getPropertyValue('--score-angle')) > 0 && document.querySelectorAll('#est-moduleList .module').length === 4`), '3D result uses calculated score and four true module results');
  await evaluate(`window.scrollTo({top:0,behavior:'instant'})`);
  await delay(400);
  const estimatorShot = await screenshot('workbench-estimator.png');

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
  check(await evaluate(`(() => { const deck = document.querySelector('.deck-base').getBoundingClientRect(), frame = document.querySelector('.graph-viewport').getBoundingClientRect(); return deck.left >= frame.left && deck.right <= frame.right && deck.bottom <= frame.bottom; })()`), 'the full 3D base fits a compact viewport');
  const mobileAxes = await evaluate(`[...document.querySelectorAll('#commandRadar .radar-axis')].map(el=>({left:el.getBoundingClientRect().left,right:el.getBoundingClientRect().right}))`);
  check(mobileAxes.length === 5 && mobileAxes.every(axis => axis.left >= 0 && axis.right <= 390), 'mobile radar keeps all five axes in view', JSON.stringify(mobileAxes));
  await evaluate(`document.querySelector('#commandPerformanceTitle').scrollIntoView({block:'center',behavior:'instant'})`);
  const mobileRadarShot = await screenshot('command-mobile-radar.png');
  await click('#commandAllNodes');
  const mobileHeights = await evaluate(`[...document.querySelectorAll('#commandMobileNodes .mobile-node-row')].map(el=>({text:el.innerText,h:el.getBoundingClientRect().height,display:getComputedStyle(el).display}))`);
  check(await evaluate(`!document.getElementById('commandMobileNodes').hidden && document.getElementById('commandAllNodes').getAttribute('aria-expanded') === 'true' && document.querySelectorAll('#commandMobileNodes .mobile-node-row').length === 13`), '390 all-causes list expands');
  check(mobileHeights.every(row => row.h >= 44), '390 all-causes rows meet touch height', JSON.stringify(mobileHeights));
  await click('#commandMobileNodes [data-node="detail_mismatch"]');
  const mobileDetail = await evaluate(`document.getElementById('commandNodeDetail').innerText`);
  check(await evaluate(`document.querySelector('#commandMobileNodes [data-node=detail_mismatch]').getAttribute('aria-pressed') === 'true' && document.querySelector('#graphNodes [data-node=detail_mismatch]').getAttribute('aria-pressed') === 'true' && document.getElementById('commandNodeDetail').innerText.includes('继续当前练习')`), 'mobile list shares selection with graph', mobileDetail);
  await setViewport(320, 720);
  check(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), '320px has no page horizontal overflow');
  const narrowButtons = await evaluate(`[...document.querySelectorAll('.mobile-node-row, .mobile-node-bar button, .graph-controls button, #commandReturn, #commandContinue, .node-train, .monitor-row, #commandShowAll')].filter(el => el.getClientRects().length).map(el=>{const r=el.getBoundingClientRect();return {text:el.innerText,left:r.left,right:r.right};})`);
  check(narrowButtons.every(rect => rect.left >= -1 && rect.right <= 321), '320px visible controls stay within page', JSON.stringify(narrowButtons.filter(rect => rect.left < -1 || rect.right > 321)));
  await click('#tab-reading');
  await click('#subtab-lab');
  check(await evaluate(`document.body.dataset.mode === 'command' && document.documentElement.scrollWidth <= innerWidth && document.querySelector('.stage-assembly').getClientRects().length > 0`), '320px 3D evidence workbench fits the screen');
  await click('#tab-command');

  await setViewport(1366, 768);
  await evaluate('scrollTo(0,0)');
  check(await evaluate(`document.body.dataset.mode === 'command' && getComputedStyle(document.querySelector('.tabnav')).position === 'fixed'`), 'wide command center keeps navigation in the header');
  await click('#commandReturn');
  check(await evaluate(`document.body.dataset.mode === 'simple' && document.querySelector('.tabnav').getClientRects().length > 0`), 'wide return reveals simple mode');
  await evaluate(`document.getElementById('tab-command').focus()`);
  await key('ArrowRight', 'ArrowRight', 39);
  check(await evaluate(`document.body.dataset.view === 'reading' && document.activeElement.id === 'tab-reading'`), 'tab arrow key wraps and moves focus');
  await click('#tab-command');
  check(await evaluate(`document.body.dataset.mode === 'command' && document.body.dataset.view === 'command'`), 'command tab returns from simple mode');
  await click('#graphZoomIn');
  check(await evaluate(`document.getElementById('graphStage').style.getPropertyValue('--graph-zoom') === '1.1'`), 'graph zoom control works');
  await click('#graphReset');
  await delay(350);
  check(await evaluate(`document.getElementById('graphStage').style.getPropertyValue('--graph-zoom') === '1'`), 'graph reset works');
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
  check(await evaluate(`document.querySelector('[data-node=causal_inversion]').getAttribute('aria-pressed') === 'true' && document.activeElement.dataset.node === 'causal_inversion'`), 'keyboard Enter selects graph node and preserves focus');
  await click('#graphReset');
  await delay(350);
  const beforeDrag = await evaluate(`(() => { const p=s=>{const r=document.querySelector(s).getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};}; return {near:p('[data-node=attitude_shift]'),far:p('[data-node=causal_inversion]')}; })()`);
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
  check(nearMove > 2 && farMove > 2 && Math.abs(nearMove - farMove) > 2, 'drag gives near and far nodes different motion', JSON.stringify({nearMove,farMove,beforeDrag,afterDrag}));
  await click('#graphReset');
  await delay(350);
  const afterReset = await evaluate(`(() => { const p=s=>{const r=document.querySelector(s).getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};}; return {near:p('[data-node=attitude_shift]'),far:p('[data-node=causal_inversion]'),selected:document.querySelector('[data-node=reading]').getAttribute('aria-pressed'),transform:document.getElementById('graphStage').style.transform}; })()`);
  check(afterReset.selected === 'true' && Math.abs(afterReset.near.x - beforeDrag.near.x) < 1.5 && Math.abs(afterReset.far.y - beforeDrag.far.y) < 1.5, 'graph reset restores default projection', JSON.stringify(afterReset));
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  check(await evaluate(`getComputedStyle(document.querySelector('.graph-node')).animationName === 'none' && getComputedStyle(document.querySelector('.graph-node')).transitionDuration === '0s'`), 'reduced motion removes graph animation');
  check(exceptions.length === 0, 'no browser runtime exceptions', exceptions.join('; '));

  console.log(JSON.stringify({ status: 'PASS', checks: checks.length, wideShot, desktopShot, simpleShot, mobileShot, radarShot, mobileRadarShot, layersShot, labShot, toolShot, estimatorShot, exceptions }, null, 2));
} finally {
  ws?.close();
  browser.kill();
  await delay(150);
  rmSync(profile, { recursive: true, force: true });
}
