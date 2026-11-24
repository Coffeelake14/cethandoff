// Owner-only translation smoke test for an explicitly selected, protected site.
// The full release acceptance still runs through the same-origin browser.
import assert from 'node:assert/strict';
import { consumeSSE } from '../web/sse.mjs';

const [site] = process.argv.slice(2);
if (!site) {
  console.error('Usage: node dev/accept-live.mjs https://<protected-site-host>');
  process.exit(2);
}
const origin = new URL(site).origin;
assert.equal(new URL(origin).protocol, 'https:', 'Use the HTTPS acceptance environment.');
const app = new URL('/functions/v1/app', origin);
const url = action => new URL('?action=' + action, app);
const signal = AbortSignal.timeout(90_000);

const capabilities = await fetch(url('capabilities'), { signal, redirect: 'error' });
assert.ok(capabilities.ok, 'This site does not expose the protected capabilities endpoint.');
const data = await capabilities.json();
assert.equal(data.requiresVisitor, true, 'This version does not require an issued visitor ticket.');
assert.equal(data.features?.explain, true, 'Translation is closed on this version.');
const issued = await fetch(url('visitor'), { method: 'POST', headers: { Origin: origin }, signal, redirect: 'error' });
assert.ok(issued.ok, `Visitor handshake returned HTTP ${issued.status}. Use the same-origin browser if platform access is required.`);
const cookie = issued.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
assert.ok(cookie, 'Set-Cookie missing from the visitor handshake.');

const startedAt = performance.now();
const response = await fetch(url('explain'), {
  method: 'POST',
  headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
  body: JSON.stringify({
    section: 'translation', level: 'CET4', part: 1, total: 1,
    text: 'On Tuesday, Mia found thirteen blue notebooks in the library.',
  }),
  signal,
  redirect: 'error',
});
assert.ok(response.ok, `Translation returned HTTP ${response.status}.`);
let text = '';
let result;
await consumeSSE(response, frame => {
  const event = JSON.parse(frame.data);
  if (event.type === 'delta') text += event.text;
  if (event.type === 'replace') text = event.text;
  if (event.type === 'error') throw new Error(event.code || 'cloud_error');
  if (event.type !== 'done') return false;
  result = event;
  return true;
}, { signal });

assert.equal(result.state, 'completed');
assert.match(text, /图书馆/);
assert.match(text, /十三|13/);
assert.match(text, /蓝/);
assert.ok(result.meta?.model, 'Actual model ID missing.');
assert.ok(response.headers.get('x-request-id'), 'Site request ID missing.');
console.log(JSON.stringify({
  origin, action: 'explain', state: result.state,
  requestId: response.headers.get('x-request-id'),
  model: result.meta.model,
  durationMs: Math.round(performance.now() - startedAt),
  credits: result.usage?.totalCredits ?? '未返回',
}, null, 2));
