// Local-only acceptance probe against the DEPLOYED public Function (real QCA).
// It now probes the short `explain` action (translation chunk), which is the
// action the reading tool uses. Note: node direct-to-site requests are usually
// rejected by the Sites gateway origin check (403); real acceptance must run in
// the same-origin browser. Kept as a probe reference.
import { SAMPLE_TEXT } from '../web/sample.js';

const URL = 'https://cet-reading-tutor-a1a088gagzl.qoder.zone/functions/v1/app?action=explain';
const ac = new AbortController();
const timer = setTimeout(() => ac.abort(), 90000);
const t0 = Date.now();
let firstDeltaMs = null;
const stats = { status: [], deltas: 0, deltaChars: 0, replaces: 0, replaceLen: 0, done: null, error: null };
let lastText = '';

const text = SAMPLE_TEXT.slice(0, 1000);
const res = await fetch(URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
  body: JSON.stringify({ section: 'translation', text, level: 'CET4', part: 1, total: 1 }),
  signal: ac.signal,
});
console.log('HTTP', res.status, res.headers.get('content-type'));
if (!res.ok || !res.body) { console.log('BODY', await res.text()); process.exit(1); }

const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '';
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  let idx;
  while ((idx = buf.indexOf('\n\n')) >= 0) {
    const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
    const dataLine = frame.split('\n').find(l => l.startsWith('data:'));
    if (!dataLine) continue;
    let msg; try { msg = JSON.parse(dataLine.slice(5).trim()); } catch { continue; }
    if (msg.type === 'status') stats.status.push(msg.state);
    else if (msg.type === 'delta') { stats.deltas++; stats.deltaChars += (msg.text || '').length; if (firstDeltaMs === null) firstDeltaMs = Date.now() - t0; lastText += msg.text || ''; }
    else if (msg.type === 'replace') { stats.replaces++; stats.replaceLen = (msg.text || '').length; lastText = msg.text || ''; }
    else if (msg.type === 'done') stats.done = msg.state;
    else if (msg.type === 'error') stats.error = msg.code + ': ' + msg.message;
  }
}
clearTimeout(timer);
const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(JSON.stringify({ secs, firstDeltaMs, ...stats, chars: lastText.length }, null, 2));
const pass = stats.done === 'completed' && stats.deltas > 5 && lastText.length > 50 && !stats.error;
console.log(pass ? 'LIVE AI ACCEPTANCE: PASS' : 'LIVE AI ACCEPTANCE: FAIL');
process.exit(pass ? 0 : 2);
