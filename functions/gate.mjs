import { createVisitorTickets } from './visitor.mjs';

export const AI_ACTIONS = ['train', 'explain', 'grade', 'recommend', 'scan'];

const DENIAL = {
  feature: ['ai_feature_unavailable', '该功能暂不可用，请稍后重试。', 503],
  origin: ['forbidden_origin', '请求来源不被允许。', 403],
  visitor: ['visitor_required', '访问凭证已失效，请刷新页面后重试。', 401],
  quotaUnavailable: ['ai_quota_unavailable', '额度服务暂不可用，请稍后重试。', 503],
  visitorLimit: ['ai_visitor_quota_exceeded', '今日访问次数已用完，请明天再试。', 429],
  budget: ['ai_quota_exceeded', '今日 AI 预算已用完，请明天再试。', 429],
  budgetBlocked: ['ai_budget_blocked', '今日 AI 服务已暂停，请明天再试。', 429],
  issueLimit: ['ai_issue_rate_limited', '访问凭证申请过于频繁，请稍后再试。', 429],
};

function deny(key) {
  const [code, message, status] = DENIAL[key];
  return { ok: false, code, message, status };
}

const QUOTA_CODE_TO_DENIAL = {
  ai_visitor_quota_exceeded: 'visitorLimit',
  ai_quota_exceeded: 'budget',
  ai_budget_blocked: 'budgetBlocked',
  ai_issue_rate_limited: 'issueLimit',
};

function denyFromQuotaError(error) {
  return deny(QUOTA_CODE_TO_DENIAL[error?.code] || 'quotaUnavailable');
}

function sameOriginRequest(request, siteOrigin) {
  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = request.headers.get('origin');
  return !origin || origin === (siteOrigin || new URL(request.url).origin);
}

async function hashIp(secret, ip) {
  const data = new TextEncoder().encode(`cet-ip|${secret}|${ip}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function clientIp(request) {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim().slice(0, 64) || 'unknown';
  return request.headers.get('x-real-ip')?.slice(0, 64) || 'unknown';
}

function featureMap(features, quota) {
  return Object.fromEntries(AI_ACTIONS.map(action => [
    action,
    features?.[action] === true && quota !== null,
  ]));
}

// Returns a gate that refuses every paid AI action. Used when configuration is
// missing or invalid so the public endpoint fails closed.
export function createClosedGate() {
  return {
    features: Object.fromEntries(AI_ACTIONS.map(action => [action, false])),
    requiresVisitor: false,
    isEnabled: () => false,
    async authorize() { return deny('feature'); },
    async admit() { return deny('feature'); },
    async issueVisitor() { return deny('feature'); },
  };
}

/**
 * @param {{
 *   secret: string, features: Record<string, boolean>,
 *   quota?: ReturnType<typeof import('./quota.mjs').createQuotaManager> | null,
 *   trustForwardedIp?: boolean, secureCookies?: boolean,
 *   siteOrigin?: string, logger?: (message: string) => void
 * }} options
 */
export function createAiGate({
  secret,
  features,
  quota = null,
  trustForwardedIp = false,
  secureCookies = true,
  siteOrigin = '',
  logger = console.error,
}) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('visitor_secret_invalid');
  const origin = siteOrigin ? new URL(siteOrigin).origin : '';
  const tickets = createVisitorTickets({ secret, secureCookies });
  const enabled = featureMap(features, quota);

  async function authorize(request, action) {
    if (enabled[action] !== true) return deny('feature');
    if (!sameOriginRequest(request, origin)) return deny('origin');
    const visitor = await tickets.verify(tickets.readCookie(request));
    if (!visitor) return deny('visitor');
    const currentIpHash = trustForwardedIp ? await hashIp(secret, clientIp(request)) : 'untrusted';
    if (visitor.ipHash !== currentIpHash) return deny('visitor');
    return { ok: true, visitorId: visitor.id };
  }

  return {
    features: { ...enabled },
    requiresVisitor: Object.values(enabled).some(Boolean),
    isEnabled: action => enabled[action] === true,

    async issueVisitor(request) {
      if (!sameOriginRequest(request, origin)) return deny('origin');
      if (!quota) return deny('quotaUnavailable');
      if (!Object.values(enabled).some(Boolean)) return deny('feature');
      // Deployments without a verified client IP share one issuance bucket.
      const ipHash = trustForwardedIp ? await hashIp(secret, clientIp(request)) : 'untrusted';
      const existingToken = tickets.readCookie(request);
      const existing = await tickets.verify(existingToken);
      if (existing?.ipHash === ipHash) {
        return { ok: true, setCookie: tickets.setCookie(request, existingToken) };
      }
      try {
        await quota.issue({ ipHash });
      } catch (error) {
        return denyFromQuotaError(error);
      }
      const visitorId = crypto.randomUUID();
      const token = await tickets.issue(visitorId, ipHash);
      return { ok: true, setCookie: tickets.setCookie(request, token) };
    },

    authorize,

    async admit(request, action) {
      const auth = await authorize(request, action);
      if (!auth.ok) return auth;
      let reservation;
      try {
        reservation = await quota.reserve({ visitorId: auth.visitorId, action });
      } catch (error) {
        return denyFromQuotaError(error);
      }
      let settled = false;
      return {
        ok: true,
        requestId: reservation.reservation_id,
        async settle(details) {
          if (settled) return;
          settled = true;
          try {
            await quota.settle(reservation, details);
          } catch (error) {
            logger(JSON.stringify({ event: 'ai_quota_settle_failed', code: error?.code || 'unknown' }));
          }
        },
      };
    },
  };
}
