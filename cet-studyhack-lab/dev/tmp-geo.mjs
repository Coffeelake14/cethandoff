import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = 'http://127.0.0.1:4318';
const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const profile = mkdtempSync(join(tmpdir(), 'cet-geo-'));
const browser = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const delay = ms => new Promise(r => setTimeout(r, ms));

const endpoint = await new Promise((resolve, reject) => {
  let text = '';
  browser.stderr.on('data', chunk => {
    text += chunk.toString();
    const m = text.match(/DevTools listening on (ws:\/\/[^\s]+)/);
    if (m) resolve(m[1]);
  });
  browser.on('error', reject);
});
const targets = await (await fetch(`${endpoint.replace('ws://', 'http://').replace(/\/devtools\/browser\/.*$/, '')}/json/list`)).json();
const page = targets.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } };
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;

await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await send('Page.navigate', { url: base });
await delay(2000);
await evaluate('localStorage.clear()');
await send('Page.navigate', { url: base });
await delay(2500);

const probe = `(() => {
  const v = document.getElementById('graphViewport').getBoundingClientRect();
  const s = document.getElementById('graphStage').getBoundingClientRect();
  const nodes = [...document.querySelectorAll('#graphNodes .graph-node')].filter(el => el.getClientRects().length).map(el => {
    const b = el.getBoundingClientRect(); const l = el.querySelector('.node-label').getBoundingClientRect();
    return { id: el.dataset.node, styleLeft: el.style.left, styleTop: el.style.top, b: [b.left,b.right], l: [l.left,l.right], side: el.dataset.side, labelW: l.width, labelText: el.querySelector('.node-label').innerText };
  });
  return { inner: innerWidth, client: document.documentElement.clientWidth, scrollW: document.documentElement.scrollWidth,
    v: [v.left,v.right,v.width,v.top,v.bottom], s: [s.left,s.right,s.width], transform: document.getElementById('graphStage').style.transform, zoom: document.getElementById('graphStage').style.getPropertyValue('--graph-zoom'), nodes };
})()`;

console.log('BEFORE', JSON.stringify(await evaluate(probe), null, 1));
await evaluate(`document.getElementById('graphReset').click()`);
await delay(400);
console.log('AFTER RESET', JSON.stringify(await evaluate(probe), null, 1));

ws.close(); browser.kill(); await delay(150); rmSync(profile, { recursive: true, force: true });
