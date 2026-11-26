import assert from 'node:assert/strict';
import { createFakeCloud } from './fake-cloud.mjs';
import { ensureResources, __resetResourceCache } from '../functions/resources.mjs';

const PROFILE = {
  scope: 'cet-vision-test:v1',
  envName: 'CET Vision Test Environment',
  agentName: 'CET Vision Test Agent',
  metadata: { app: 'cet-vision-test' },
  purpose: 'test',
  vision: true,
  modelEnv: 'CET_SCAN_MODEL',
};
const originalDeno = globalThis.Deno;
let passed = 0;
const ok = name => { passed++; console.log(`  ok  ${name}`); };

function env(model, verified) {
  globalThis.Deno = { env: { get: name => name === 'CET_SCAN_MODEL' ? model : name === 'CET_SCAN_VERIFIED' ? verified : '' } };
}
function modelCloud(models) {
  const fake = createFakeCloud({ delayMs: 1 });
  return {
    findResources: (...args) => fake.findResources(...args),
    openStream: (...args) => fake.openStream(...args),
    request: (path, options) => path === '/api/v1/cloud/models'
      ? Promise.resolve({ data: models })
      : fake.request(path, options),
  };
}

try {
  for (const scenario of [
    { name: 'no explicit model', model: '', verified: '1', expected: 'ai_vision_unsupported' },
    { name: 'model outside the account catalog', model: 'missing-vision', verified: '1', expected: 'ai_vision_unsupported' },
    { name: 'undeclared model without live acceptance', model: 'text-only', verified: '', expected: 'ai_vision_unsupported' },
  ]) {
    __resetResourceCache();
    env(scenario.model, scenario.verified);
    await assert.rejects(
      () => ensureResources(
        modelCloud([{ id: 'text-only', enabled: true }, { id: 'vision-ok', enabled: true, supports_vision: true }]),
        `${PROFILE.scope}-${scenario.name}`,
        'test prompt',
        PROFILE,
      ),
      error => error?.code === scenario.expected,
      scenario.name,
    );
    ok(`${scenario.name} fails closed`);
  }

  __resetResourceCache();
  env('text-only', '1');
  const accepted = await ensureResources(
    modelCloud([{ id: 'text-only', enabled: true }]),
    `${PROFILE.scope}-verified`,
    'test prompt',
    PROFILE,
  );
  assert.equal(accepted.model, 'text-only');
  assert.equal(accepted.visionDeclared, false);
  assert.equal(accepted.modelSource, 'verified-env');
  ok('live-accepted model is allowed only through the explicit env binding');

  __resetResourceCache();
  env('', '');
  const text = await ensureResources(
    modelCloud([{ id: 'text-only', enabled: true }, { id: 'vision-ok', enabled: true, supports_vision: true }]),
    `${PROFILE.scope}-text`,
    'test prompt',
    { ...PROFILE, vision: false, modelEnv: '' },
  );
  assert.equal(typeof text.model, 'string');
  ok('non-vision features still use the normal model pool');
} finally {
  __resetResourceCache();
  if (originalDeno) globalThis.Deno = originalDeno; else delete globalThis.Deno;
}

console.log(`${passed} resource checks passed.`);
