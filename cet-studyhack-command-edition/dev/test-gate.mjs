import assert from 'node:assert/strict';
import { createAiGate, createClosedGate } from '../functions/gate.mjs';
import { createAppHandler } from '../functions/handler.mjs';
import { createFakeCloud } from './fake-cloud.mjs';

const SECRET = 'test-secret-'.padEnd(40, 'x');
const FEATURES = { train: true, explain: true, grade: true, recommend: true, scan: false };
let passed = 0;
const ok = name => { passed++; console.log(`  ok  ${name}`); };

function quotaFake() {
  const calls = { issue: 0, reserve: 0, settle: [] };
  return {
    calls,
    async issue() { calls.issue++; return { ok: true }; },
    async reserve(input) { calls.reserve++; return { reservation_id: 'r1', ...input }; },
    async settle(reservation, details) { calls.settle.push({ reservation, details }); },
  };
}

async function ticketFor(gate, ip = '203.0.113.1') {
  const issued = await gate.issueVisitor(new Request('http://local/functions/v1/app?action=visitor', {
    method: 'POST',
    headers: { 'sec-fetch-site': 'same-origin', 'x-forwarded-for': ip },
  }));
  assert.equal(issued.ok, true);
  const token = issued.setCookie.split(';')[0].slice('cet_visitor='.length);
  return { token, issued };
}

const quota = quotaFake();
const gate = createAiGate({ secret: SECRET, features: FEATURES, quota, trustForwardedIp: true, secureCookies: false });

{
  const closed = createClosedGate();
  assert.equal(closed.isEnabled('train'), false);
  assert.equal((await closed.admit(new Request('http://local'), 'train')).code, 'ai_feature_unavailable');
  ok('missing configuration closes all AI actions');
}

{
  const result = await gate.issueVisitor(new Request('http://local/functions/v1/app?action=visitor', {
    method: 'POST', headers: { 'sec-fetch-site': 'cross-site' },
  }));
  assert.equal(result.code, 'forbidden_origin');
  ok('cross-site visitor issuance is refused');
}

const { token, issued } = await ticketFor(gate);
assert.equal(quota.calls.issue, 1);
assert.match(issued.setCookie, /HttpOnly/);
assert.match(issued.setCookie, /SameSite=Lax/);

{
  const repeated = await gate.issueVisitor(new Request('http://local/functions/v1/app?action=visitor', {
    method: 'POST',
    headers: { cookie: `cet_visitor=${token}`, 'sec-fetch-site': 'same-origin', 'x-forwarded-for': '203.0.113.1' },
  }));
  assert.equal(repeated.ok, true);
  assert.equal(quota.calls.issue, 1, 'valid ticket reuse must not consume issuance quota');
  ok('visitor ticket is reusable and issuance-limited');
}

{
  const denied = await gate.admit(new Request('http://local/functions/v1/app?action=train', { method: 'POST' }), 'train');
  assert.equal(denied.code, 'visitor_required');
  assert.equal(quota.calls.reserve, 0);
  ok('AI action without a signed visitor ticket never reserves quota');
}

{
  const denied = await gate.admit(new Request('http://local/functions/v1/app?action=train', {
    method: 'POST', headers: { cookie: `cet_visitor=${token}`, 'sec-fetch-site': 'cross-site' },
  }), 'train');
  assert.equal(denied.code, 'forbidden_origin');
  assert.equal(quota.calls.reserve, 0);
  ok('cross-site AI action never reserves quota');
}

{
  const denied = await gate.admit(new Request('http://local/functions/v1/app?action=scan', {
    method: 'POST', headers: { cookie: `cet_visitor=${token}` },
  }), 'scan');
  assert.equal(denied.code, 'ai_feature_unavailable');
  assert.equal(quota.calls.reserve, 0);
  ok('disabled scan feature fails before quota and model access');
}

{
  const denied = await gate.admit(new Request('http://local/functions/v1/app?action=train', {
    method: 'POST', headers: { cookie: `cet_visitor=${token}`, 'x-forwarded-for': '203.0.113.2' },
  }), 'train');
  assert.equal(denied.code, 'visitor_required');
  assert.equal(quota.calls.reserve, 0);
  ok('visitor ticket cannot be moved between trusted IPs');
}

let admitted;
{
  const result = await gate.admit(new Request('http://local/functions/v1/app?action=train', {
    method: 'POST', headers: { cookie: `cet_visitor=${token}`, 'x-forwarded-for': '203.0.113.1' },
  }), 'train');
  assert.equal(result.ok, true);
  admitted = result;
  await result.settle({ actualCredits: 3, status: 'completed', requestId: 'sess_test' });
  await result.settle({ actualCredits: 99, status: 'completed', requestId: 'sess_test' });
  assert.equal(quota.calls.settle.length, 1);
  assert.equal(quota.calls.settle[0].details.actualCredits, 3);
  ok('one admitted AI action settles its reservation exactly once');
}

const cloud = createFakeCloud({ delayMs: 1 });
const handler = createAppHandler({ cloud, gate });
const capabilities = await handler(new Request('http://local/functions/v1/app?action=capabilities'));
assert.deepEqual((await capabilities.json()).features, FEATURES);
const health = await handler(new Request('http://local/functions/v1/app?action=health'));
assert.deepEqual(await health.json(), { ok: true });

const before = cloud.getEventsPosted();
const blocked = await handler(new Request('http://local/functions/v1/app?action=train', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.1' },
  body: JSON.stringify({
    material: {
      sentences: [{ id: 's1', text: 'The evidence sentence is long enough.' }],
      question: { stem: 'Which choice follows from the evidence?', options: [
        { key: 'A', text: 'First option' }, { key: 'B', text: 'Second option' },
        { key: 'C', text: 'Third option' }, { key: 'D', text: 'Fourth option' },
      ] },
    },
    attempt: { choice: 'A' },
  }),
}));
assert.equal(blocked.status, 401);
assert.equal((await blocked.json()).error, 'visitor_required');
assert.equal(cloud.getEventsPosted(), before);
ok('handler blocks unticketed AI before contacting cloud');

console.log(`${passed} gate checks passed.`);
