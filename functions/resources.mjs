// Lazy, server-owned bootstrap of the shared Agents + Environments.
//
// This tool is stateless: every request is an independent one-shot Session and
// no visitor data is persisted. The Cloud account's resource metadata is the
// durable source of truth for each shared Agent/Environment binding. We reconcile
// by exact metadata before creating, cache the resolved binding per scope, and
// serialize concurrent first-use with a single in-flight promise per scope. The
// Agent create carries a stable Idempotency-Key so concurrent creates dedupe
// upstream. An ambiguous create outcome is never blindly retried: the next
// request re-scans metadata first, reconciling a lost-but-successful create.
//
// Two profiles coexist (reading tutor + score estimator); each keeps its own
// scope so the existing account Agents are reused rather than recreated.

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}

async function digest(value) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

function pickModel(models) {
  const list = Array.isArray(models?.data) ? models.data : [];
  const usable = list.filter(m => m && typeof m.id === 'string'
    && (m.enabled === undefined || m.enabled === true || m.status === 'enabled' || m.status === 'active'));
  const pool = usable.length ? usable : list.filter(m => m && typeof m.id === 'string');
  if (!pool.length) {
    const err = new Error('ai_not_configured');
    err.code = 'ai_not_configured';
    throw err;
  }
  const preferred = pool.find(m => /claude|sonnet|qwen-?max|qwen-?plus|gpt-?[45]|gemini.*pro|deepseek/i.test(m.id));
  return (preferred || pool[0]).id;
}

const cache = new Map();

async function ensureOne(cloud, kind, definition, scope) {
  const body = JSON.parse(JSON.stringify(definition));
  const fingerprint = await digest(canonical(body));
  const metadata = { ...body.metadata, qsites_scope: scope, qsites_kind: kind, qsites_config: fingerprint };
  body.metadata = metadata;

  const matches = await cloud.findResources(kind, metadata);
  if (matches.length > 1) {
    const err = new Error('ai_initialization_conflict');
    err.code = 'ai_initialization_conflict';
    err.status = 409;
    throw err;
  }
  if (matches.length === 1) {
    const resource = matches[0];
    return kind === 'agents'
      ? { id: resource.id, version: resource.version }
      : { id: resource.id };
  }

  const key = await digest(`${scope}:${kind}:${fingerprint}`);
  const resource = await cloud.request(`/api/v1/cloud/${kind}`, {
    method: 'POST',
    body,
    ...(kind === 'agents' ? { idempotencyKey: `sites-agent-${key}` } : {}),
  });
  if (!resource || typeof resource.id !== 'string') {
    const err = new Error('ai_response_invalid');
    err.code = 'ai_response_invalid';
    throw err;
  }
  return kind === 'agents'
    ? { id: resource.id, version: resource.version }
    : { id: resource.id };
}

// profile: { envName, agentName, metadata, purpose }
export async function ensureResources(cloud, scope, systemPrompt, profile) {
  let entry = cache.get(scope);
  if (!entry) { entry = { binding: null, inflight: null }; cache.set(scope, entry); }
  if (entry.binding) return entry.binding;
  if (entry.inflight) return entry.inflight;
  entry.inflight = (async () => {
    const models = await cloud.request('/api/v1/cloud/models');
    const model = pickModel(models);
    const environment = await ensureOne(cloud, 'environments', {
      name: profile.envName,
      config: { type: 'cloud' },
      metadata: { ...profile.metadata },
    }, scope);
    const agent = await ensureOne(cloud, 'agents', {
      name: profile.agentName,
      model,
      system: systemPrompt,
      tools: [],
      metadata: { ...profile.metadata, purpose: profile.purpose },
    }, scope);
    if (!Number.isInteger(agent.version) || agent.version < 1) {
      const err = new Error('ai_response_invalid');
      err.code = 'ai_response_invalid';
      throw err;
    }
    const binding = {
      agent: { type: 'agent', id: agent.id, version: agent.version },
      environment_id: environment.id,
      model,
    };
    entry.binding = binding;
    return binding;
  })();
  try {
    return await entry.inflight;
  } catch (error) {
    entry.binding = null;
    throw error;
  } finally {
    entry.inflight = null;
  }
}

// Test seam: reset the per-instance cache between fixture runs.
export function __resetResourceCache() {
  cache.clear();
}