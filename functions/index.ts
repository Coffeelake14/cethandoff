import { createCloudAgentsClient } from './cloud-agents.mjs';
import { createAppHandler } from './handler.mjs';
import { createQuotaManager } from './quota.mjs';
import { createAiGate, createClosedGate } from './gate.mjs';

function env(name: string): string {
  try { return globalThis.Deno?.env.get(name) || ''; } catch { return ''; }
}

function integerEnv(name: string): number | null {
  const value = env(name);
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

const features = {
  train: env('CET_ENABLE_TRAIN') === '1',
  explain: env('CET_ENABLE_EXPLAIN') === '1',
  grade: env('CET_ENABLE_GRADE') === '1',
  recommend: env('CET_ENABLE_RECOMMEND') === '1',
  scan: env('CET_ENABLE_SCAN') === '1'
    && env('CET_SCAN_VERIFIED') === '1'
    && env('CET_SCAN_MODEL').trim() !== '',
};

const visitorSecret = env('CET_VISITOR_SECRET');
let quota: ReturnType<typeof createQuotaManager> | null = null;
const backendModulePath = './_qoder/backend.mjs';
try {
  // This module exists only in the production platform bundle. Keeping the
  // specifier dynamic lets local and legacy bundles load without it.
  const backend = await import(backendModulePath);
  if (typeof backend.createDatabaseClient !== 'function') throw new Error('database_client_missing');
  const db = await backend.createDatabaseClient();
  const config = {
    dailyBudgetCredits: integerEnv('CET_AI_DAILY_BUDGET_CREDITS'),
    reserveCredits: integerEnv('CET_AI_RESERVE_CREDITS'),
    visitorMaxRequests: integerEnv('CET_VISITOR_MAX_REQUESTS'),
    issueMaxPerIp: integerEnv('CET_ISSUE_MAX_PER_IP'),
  };
  const { dailyBudgetCredits, reserveCredits, visitorMaxRequests, issueMaxPerIp } = config;
  if (dailyBudgetCredits !== null && reserveCredits !== null
    && visitorMaxRequests !== null && issueMaxPerIp !== null) {
    quota = createQuotaManager({ db, config: { dailyBudgetCredits, reserveCredits, visitorMaxRequests, issueMaxPerIp } });
  }
} catch (error) {
  // Null quota is intentional: the handler must reject public AI calls closed.
  console.error(JSON.stringify({
    event: 'ai_quota_initialization_failed',
    code: error instanceof Error ? error.name : 'unknown',
  }));
}

const cloud = createCloudAgentsClient({ origin: 'https://api.qoder.com.cn' });
const trustForwardedIp = env('CET_TRUST_FORWARDED_IP') === '1';
let gate: ReturnType<typeof createClosedGate> | ReturnType<typeof createAiGate> = createClosedGate();
try {
  if (visitorSecret.length < 32) throw new Error('visitor_secret_invalid');
  if (!env('QODER_PAT').trim()) throw new Error('cloud_credentials_missing');
  gate = createAiGate({
    secret: visitorSecret,
    features,
    quota,
    trustForwardedIp,
    secureCookies: true,
    siteOrigin: env('CET_SITE_ORIGIN'),
  });
} catch (error) {
  console.error(JSON.stringify({
    event: 'ai_gate_initialization_failed',
    code: error instanceof Error ? error.name : 'unknown',
  }));
}

const handler = createAppHandler({
  cloud,
  gate,
  trustForwardedIp,
  resourceCoordinator: quota?.coordinator || null,
});

Deno.serve(handler);
