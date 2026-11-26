import assert from 'node:assert/strict';
import { createQuotaManager } from '../functions/quota.mjs';
import { createVisitorTickets } from '../functions/visitor.mjs';

const PRIMARY_KEYS = {
  ai_budget: ['window_start'],
  ai_visitor_usage: ['visitor_hash', 'window_start'],
  ai_issuance: ['ip_hash', 'window_start'],
  ai_reservations: ['reservation_id'],
  ai_usage_log: ['reservation'],
  ai_resource_bindings: ['binding_key'],
  cas_probe: ['id'],
};

const clone = value => value === undefined ? undefined : structuredClone(value);

// A deliberately strict Supabase-style fake. Every update is applied once,
// synchronously, only when ALL filters (including record_version) match.
class MemoryCasDb {
  constructor() {
    this.tables = new Map();
    this.failures = [];
    this.stats = { updates: 0, versionMismatches: 0 };
  }

  from(table) { return new Query(this, table); }

  rows(table) { return this.tables.get(table) || []; }

  seed(table, row) {
    if (!this.tables.has(table)) this.tables.set(table, []);
    this.tables.get(table).push(clone(row));
  }

  failNext(table, operation) { this.failures.push({ table, operation }); }

  takeFailure(table, operation) {
    const index = this.failures.findIndex(item => item.table === table && item.operation === operation);
    if (index < 0) return null;
    return this.failures.splice(index, 1)[0];
  }

  matches(row, filters) {
    return filters.every(([operator, column, expected]) => {
      if (operator === 'eq') return row[column] === expected;
      if (operator === 'lte') return row[column] <= expected;
      throw new Error(`unsupported_filter:${operator}`);
    });
  }
}

class Query {
  constructor(db, table) {
    this.db = db;
    this.table = table;
    this.mode = 'select';
    this.filters = [];
    this.returning = false;
    this.payload = null;
  }

  select(_columns = '*') {
    if (this.mode === 'update') this.returning = true;
    return this;
  }

  update(payload) {
    this.mode = 'update';
    this.payload = payload;
    return this;
  }

  insert(payload) {
    this.mode = 'insert';
    this.payload = payload;
    return this;
  }

  insertIfAbsent(payload) {
    this.mode = 'insertIfAbsent';
    this.payload = payload;
    return this;
  }

  eq(column, value) { this.filters.push(['eq', column, value]); return this; }
  lte(column, value) { this.filters.push(['lte', column, value]); return this; }

  then(resolve, reject) { return this.execute().then(resolve, reject); }

  async execute() {
    const failure = this.db.takeFailure(this.table, this.mode);
    if (failure) return { data: null, error: { code: 'injected_failure' } };
    const table = this.db.tables.get(this.table) || [];
    const keys = PRIMARY_KEYS[this.table];
    if (!keys) throw new Error(`unknown_table:${this.table}`);

    if (this.mode === 'select') {
      return { data: clone(table.filter(row => this.db.matches(row, this.filters))), error: null };
    }

    if (this.mode === 'insert' || this.mode === 'insertIfAbsent') {
      const incoming = Array.isArray(this.payload) ? this.payload : [this.payload];
      const added = [];
      for (const row of incoming) {
        const duplicate = table.some(existing => keys.every(key => existing[key] === row[key]));
        if (duplicate) {
          if (this.mode === 'insert') return { data: null, error: { code: '23505' } };
          continue;
        }
        table.push(clone(row));
        added.push(clone(row));
      }
      this.db.tables.set(this.table, table);
      return { data: added, error: null };
    }

    if (this.mode === 'update') {
      this.db.stats.updates += 1;
      const hasVersion = this.filters.some(([, column]) => column === 'record_version');
      const versionMatches = table.some(row => this.db.matches(row, this.filters));
      if (hasVersion && !versionMatches) {
        this.db.stats.versionMismatches += 1;
        if (!this.db.lastMismatch) this.db.lastMismatch = { table: this.table, filters: clone(this.filters), rows: clone(table) };
      }
      const affected = [];
      for (const row of table) {
        if (!this.db.matches(row, this.filters)) continue;
        Object.assign(row, clone(this.payload));
        affected.push(clone(row));
      }
      return { data: this.returning ? affected : null, error: null };
    }

    throw new Error(`unsupported_operation:${this.mode}`);
  }
}

const BASE_CONFIG = {
  dailyBudgetCredits: 100,
  reserveCredits: 2,
  visitorMaxRequests: 10,
  visitorWindowMs: 86400000,
  issueMaxPerIp: 5,
  issueWindowMs: 86400000,
};

function fixture(configOverrides = {}) {
  let clock = Date.UTC(2026, 10, 24, 12, 0, 0);
  const db = new MemoryCasDb();
  const manager = createQuotaManager({
    db,
    config: { ...BASE_CONFIG, ...configOverrides },
    now: () => clock,
    logger: console.error,
  });
  return {
    db,
    manager,
    setNow(value) { clock = value; },
    advance(ms) { clock += ms; },
    row(table, filters = {}) {
      const row = db.rows(table).find(item => Object.entries(filters).every(([key, value]) => item[key] === value));
      assert.ok(row, `missing ${table} row`);
      return row;
    },
  };
}

function hasCode(code) {
  return error => error?.code === code;
}

const tests = [];
const test = (name, run) => tests.push({ name, run });

test('fake update truly enforces record_version CAS', async () => {
  const { db, row } = fixture();
  db.seed('cas_probe', { id: 'one', value: 'old', record_version: 0 });
  const rejected = await db.from('cas_probe').update({ value: 'wrong' })
    .eq('id', 'one').eq('record_version', 99).select();
  assert.deepEqual(rejected.data, []);
  assert.equal(row('cas_probe').value, 'old');
  const accepted = await db.from('cas_probe').update({ value: 'new', record_version: 1 })
    .eq('id', 'one').eq('record_version', 0).select();
  assert.equal(accepted.data.length, 1);
  assert.equal(row('cas_probe').record_version, 1);
  assert.equal(db.stats.versionMismatches, 1);
});

test('visitor ticket signs, verifies, expires and rejects tampering', async () => {
  assert.throws(() => createVisitorTickets({ secret: 'too-short' }), /at_least_32/);
  const tickets = createVisitorTickets({ secret: 's'.repeat(32), ttlMs: 1000, secureCookies: true });
  const originalNow = Date.now;
  let clock = 1000;
  Date.now = () => clock;
  try {
    const token = await tickets.issue('visitor-hash', 'ip-hash');
    assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.deepEqual(await tickets.verify(token), {
      v: 1, id: 'visitor-hash', exp: 2000, ipHash: 'ip-hash',
    });
    const [payload, signature] = token.split('.');
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    decoded.id = 'tampered-visitor';
    const tampered = `${Buffer.from(JSON.stringify(decoded)).toString('base64url')}.${signature}`;
    assert.equal(await tickets.verify(tampered), null);
    assert.equal(await tickets.verify(`${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`), null);
    clock = 2000;
    assert.equal(await tickets.verify(token), null);
  } finally {
    Date.now = originalNow;
  }

  const request = new Request('https://example.test/', {
    headers: { cookie: 'other=1; cet_visitor=abc.def; tail=2' },
  });
  assert.equal(tickets.readCookie(request), 'abc.def');
  const header = tickets.setCookie(request, 'abc.def');
  assert.match(header, /^cet_visitor=abc\.def/);
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Lax/);
  assert.match(header, /Path=\//);
  assert.match(header, /Secure/);
  const localTickets = createVisitorTickets({ secret: 'x'.repeat(32), secureCookies: false });
  assert.doesNotMatch(localTickets.setCookie(request, 'abc.def'), /Secure/);
});

test('concurrent reserves never exceed the global budget', async () => {
  const { db, manager, row } = fixture({ dailyBudgetCredits: 10, reserveCredits: 3 });
  const results = await Promise.allSettled(Array.from({ length: 12 }, (_, index) => manager.reserve({
    visitorId: `visitor-${index}`, action: 'train',
  })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 3,
    results.filter(result => result.status === 'rejected').map(result => `${result.reason.code}:${result.reason.operation || result.reason.message}`).join(', '));
  assert.equal(results.filter(result => result.status === 'rejected'
    && hasCode('ai_quota_exceeded')(result.reason)).length, 9);
  const budget = row('ai_budget');
  assert.equal(budget.reserved_credits, 9);
  assert.equal(budget.spent_credits, 0);
  assert.ok(budget.spent_credits + budget.reserved_credits <= 10);
  assert.equal(Object.keys(budget.active_reservations).length, 3);
  assert.ok(db.stats.versionMismatches > 0, 'the fake must have rejected stale-version writes');
});

test('concurrent reserves enforce the visitor request ceiling', async () => {
  const { manager, row } = fixture({ visitorMaxRequests: 2, reserveCredits: 1 });
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => manager.reserve({
    visitorId: 'same-visitor', action: 'explain',
  })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 2);
  assert.equal(results.filter(result => result.status === 'rejected'
    && hasCode('ai_visitor_quota_exceeded')(result.reason)).length, 6);
  assert.equal(row('ai_visitor_usage').request_count, 2);
  assert.equal(row('ai_budget').reserved_credits, 2);
});

test('an exhausted budget rejects later calls', async () => {
  const { manager } = fixture({ dailyBudgetCredits: 4, reserveCredits: 2 });
  await manager.reserve({ visitorId: 'a', action: 'train' });
  await manager.reserve({ visitorId: 'b', action: 'train' });
  await assert.rejects(manager.reserve({ visitorId: 'c', action: 'train' }), hasCode('ai_quota_exceeded'));
});

test('visitor failure releases the global hold and durable intent', async () => {
  const { manager, row } = fixture({ visitorMaxRequests: 0, reserveCredits: 2 });
  await assert.rejects(manager.reserve({ visitorId: 'blocked', action: 'train' }), hasCode('ai_visitor_quota_exceeded'));
  assert.equal(row('ai_budget').reserved_credits, 0);
  assert.deepEqual(row('ai_budget').active_reservations, {});
  assert.equal(row('ai_reservations').status, 'released');
  assert.equal(row('ai_visitor_usage').request_count, 0);
});

test('database failure after the global hold also rolls it back', async () => {
  const { db, manager, row } = fixture();
  db.failNext('ai_visitor_usage', 'update');
  await assert.rejects(manager.reserve({ visitorId: 'db-failure', action: 'train' }), hasCode('ai_quota_unavailable'));
  assert.equal(row('ai_budget').reserved_credits, 0);
  assert.deepEqual(row('ai_budget').active_reservations, {});
  assert.equal(row('ai_reservations').status, 'released');
});

test('actual=null retains the reservation and logs missing usage', async () => {
  const { manager, row } = fixture({ reserveCredits: 2 });
  const reservation = await manager.reserve({ visitorId: 'null-usage', action: 'grade' });
  const result = await manager.settle(reservation, {
    actualCredits: null, status: 'completed', requestId: 'request-null', model: 'model-a', durationMs: 20,
  });
  assert.equal(result.budgetBlocked, false);
  assert.equal(row('ai_budget').reserved_credits, 2);
  assert.equal(row('ai_reservations').status, 'usage_missing');
  const log = row('ai_usage_log');
  assert.equal(log.credits, null);
  assert.equal(log.usage_status, '未返回');
  assert.equal(log.status, 'completed');
  assert.equal(log.reservation, reservation.reservation_id);
  assert.equal(log.request_id, 'request-null');
  assert.ok(!Object.hasOwn(log, 'prompt'));
  assert.ok(!Object.hasOwn(log, 'ip'));
});

test('normal settlement releases only the unused reserve and is idempotent', async () => {
  const { db, manager, row } = fixture({ dailyBudgetCredits: 10, reserveCredits: 2 });
  const reservation = await manager.reserve({ visitorId: 'settled', action: 'scan' });
  await manager.settle(reservation, { actualCredits: 1, status: 'completed', durationMs: 50 });
  await manager.settle(reservation, { actualCredits: 1, status: 'completed', durationMs: 50 });
  assert.equal(row('ai_budget').spent_credits, 1);
  assert.equal(row('ai_budget').reserved_credits, 0);
  assert.equal(row('ai_reservations').status, 'settled');
  assert.equal(db.rows('ai_usage_log').length, 1);
});

test('actual above reserve blocks later calls without breaking the hard cap', async () => {
  const { manager, row } = fixture({ dailyBudgetCredits: 10, reserveCredits: 2 });
  const reservation = await manager.reserve({ visitorId: 'overrun', action: 'train' });
  const result = await manager.settle(reservation, {
    actualCredits: 3, status: 'completed', requestId: 'request-over', model: 'model-b', durationMs: 80,
  });
  assert.equal(result.budgetBlocked, true);
  const budget = row('ai_budget');
  assert.equal(budget.blocked, true);
  assert.equal(budget.blocked_reason, 'actual_exceeded_reserve');
  assert.equal(budget.spent_credits, 2);
  assert.equal(budget.reserved_credits, 0);
  assert.ok(budget.spent_credits + budget.reserved_credits <= 10);
  assert.equal(row('ai_usage_log').credits, 3);
  await assert.rejects(manager.reserve({ visitorId: 'later', action: 'train' }), hasCode('ai_budget_blocked'));
});

test('ten-minute cleanup conservatively accounts for expired and crash-orphaned holds', async () => {
  const { db, manager, row, advance, setNow } = fixture({ reserveCredits: 2 });
  const start = Date.UTC(2026, 10, 24, 12, 0, 0);
  const reservation = await manager.reserve({ visitorId: 'expiring', action: 'train' });
  advance(10 * 60 * 1000 + 1);
  await manager.cleanup();
  assert.equal(row('ai_budget').reserved_credits, 0);
  assert.equal(row('ai_budget').spent_credits, 2);
  assert.deepEqual(row('ai_budget').active_reservations, {});
  assert.equal(row('ai_reservations', { reservation_id: reservation.reservation_id }).status, 'expired');

  // Simulate a crash after the atomic budget-ledger write but before the
  // ai_reservations insert: there is no reservation row to find, only the ledger.
  const orphanWindow = new Date(start + 86400000).toISOString().slice(0, 10);
  db.seed('ai_budget', {
    window_start: orphanWindow,
    daily_budget_credits: 10,
    reserve_credits: 2,
    spent_credits: 0,
    reserved_credits: 2,
    active_reservations: {
      orphan: { credits: 2, created_at: new Date(start).toISOString() },
    },
    blocked: false,
    blocked_reason: null,
    record_version: 0,
    updated_at: new Date(start).toISOString(),
  });
  setNow(start + 86400000 + 600001);
  await manager.cleanup();
  assert.equal(row('ai_budget', { window_start: orphanWindow }).reserved_credits, 0);
  assert.equal(row('ai_budget', { window_start: orphanWindow }).spent_credits, 2);
  assert.deepEqual(row('ai_budget', { window_start: orphanWindow }).active_reservations, {});
});

test('coordinator permits one holder and fences a stale lease', async () => {
  const { manager, row } = fixture();
  let releaseGate;
  let signalEntered;
  const gate = new Promise(resolve => { releaseGate = resolve; });
  const entered = new Promise(resolve => { signalEntered = resolve; });
  let staleLease;

  const first = manager.coordinator.withLock('shared-resources', async lease => {
    staleLease = lease;
    signalEntered();
    await gate;
    assert.equal(await lease.assertHeld(), true);
    await lease.write({ agent: { id: 'agent-one', version: 1 }, model: 'model-a' });
    return lease.read();
  });
  await entered;
  await assert.rejects(manager.coordinator.withLock('shared-resources', async () => 'must not enter'),
    hasCode('ai_resource_lock_busy'));
  releaseGate();
  assert.equal((await first).agent.id, 'agent-one');

  await manager.coordinator.withLock('shared-resources', async lease => {
    await assert.rejects(staleLease.assertHeld(), hasCode('ai_resource_lease_lost'));
    await assert.rejects(staleLease.write({ agent: { id: 'stale' } }), hasCode('ai_resource_lease_lost'));
    assert.equal((await lease.read()).agent.id, 'agent-one');
    await lease.write({ agent: { id: 'agent-two', version: 2 }, model: 'model-b' });
  });
  assert.equal(row('ai_resource_bindings').binding.agent.id, 'agent-two');
  assert.ok(row('ai_resource_bindings').record_version >= 4);
});

test('ticket issuance is CAS-limited per IP and UTC window', async () => {
  const { manager, row } = fixture({ issueMaxPerIp: 2 });
  const results = await Promise.allSettled(Array.from({ length: 7 }, () => manager.issue({ ipHash: 'same-ip-hash' })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 2);
  assert.equal(results.filter(result => result.status === 'rejected'
    && hasCode('ai_issue_rate_limited')(result.reason)).length, 5);
  assert.equal(row('ai_issuance').issue_count, 2);
  assert.match(row('ai_issuance').window_start, /^2026-11-24$/);
});

test('database read failure closes the quota path', async () => {
  const { db, manager } = fixture();
  db.failNext('ai_budget', 'select');
  await assert.rejects(manager.reserve({ visitorId: 'closed', action: 'train' }), hasCode('ai_quota_unavailable'));
  assert.equal(db.rows('ai_reservations').length, 0);
});

let passed = 0;
for (const { name, run } of tests) {
  try {
    await run();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    console.error(`  not ok  ${name}`);
    console.error(error);
    process.exitCode = 1;
    break;
  }
}
if (!process.exitCode) console.log(`\n${passed} quota/visitor/coordinator tests passed.`);
