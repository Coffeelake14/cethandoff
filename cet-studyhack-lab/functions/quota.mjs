const RESERVATION_TTL_MS = 10 * 60 * 1000;
const LEASE_MS = 120 * 1000;
const CAS_ATTEMPTS = 80;
const TERMINAL_RESERVATION_STATES = new Set(['settled', 'budget_blocked', 'released', 'expired']);

function quotaError(code, message, status = 429) {
  return Object.assign(new Error(code), { code, status, message });
}

function unavailable(operation) {
  const error = quotaError('ai_quota_unavailable', 'AI quota storage is unavailable.', 503);
  error.operation = operation;
  return error;
}

function validateConfig(config) {
  const names = [
    'dailyBudgetCredits', 'reserveCredits', 'visitorMaxRequests',
    'issueMaxPerIp',
  ];
  for (const name of names) {
    if (!Number.isSafeInteger(config?.[name]) || config[name] < 0) {
      throw new Error(`quota_config_invalid:${name}`);
    }
  }
  if (config.reserveCredits === 0) throw new Error('quota_config_invalid:reserve_credits_zero');
  if (config.reserveCredits > config.dailyBudgetCredits) throw new Error('quota_config_invalid:reserve_exceeds_budget');
}

function safeText(value, name, { max = 256, nullable = false } = {}) {
  if (value === null || value === undefined) {
    if (nullable) return null;
    throw new Error(`${name}_invalid`);
  }
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\r\n]/.test(value)) {
    throw new Error(`${name}_invalid`);
  }
  return value;
}

function dbInteger(value, name) {
  const number = typeof value === 'bigint' ? Number(value) : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`quota_response_invalid:${name}`);
  return number;
}

function creditAmount(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${name}_invalid`);
  const rounded = Math.ceil(value);
  if (!Number.isSafeInteger(rounded)) throw new Error(`${name}_invalid`);
  return rounded;
}

function utcWindow(milliseconds) {
  return new Date(milliseconds).toISOString().slice(0, 10);
}

function isoTime(milliseconds) {
  return new Date(milliseconds).toISOString();
}

function reservationMap(value) {
  if (typeof value === 'string') {
    try { return reservationMap(JSON.parse(value)); } catch { return {}; }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function publicReservation(row) {
  return {
    ...row,
    id: row.reservation_id,
    reservationId: row.reservation_id,
    reserveCredits: row.reserved_credits,
    visitorId: row.visitor_hash,
    windowStart: row.window_start,
  };
}

/**
 * @param {{
 *   db: {from: (table: string) => any},
 *   config: {dailyBudgetCredits: number, reserveCredits: number, visitorMaxRequests: number, issueMaxPerIp: number},
 *   now?: () => number,
 *   logger?: (message: string) => void
 * }} options
 */
export function createQuotaManager({ db, config, now = Date.now, logger = console.error }) {
  validateConfig(config);
  if (!db || typeof db.from !== 'function') throw new Error('quota_database_invalid');
  if (typeof now !== 'function' || typeof logger !== 'function') throw new Error('quota_runtime_invalid');

  function diagnostic(event, operation, error) {
    try {
      logger(JSON.stringify({
        event,
        operation,
        code: typeof error?.code === 'string' ? error.code : 'unknown',
        failedOperation: typeof error?.operation === 'string' ? error.operation : undefined,
      }));
    } catch { /* Logging must not change fail-closed behavior. */ }
  }

  async function execute(operation, query) {
    try {
      const result = await query;
      if (!result || typeof result !== 'object') throw new Error('invalid_result');
      if (result.error) throw result.error;
      return result;
    } catch (error) {
      diagnostic('ai_quota_database_error', operation, error);
      throw unavailable(operation);
    }
  }

  function rows(result, operation) {
    if (!Array.isArray(result.data)) throw unavailable(operation);
    return result.data;
  }

  async function selectRows(table, filters = []) {
    let query = db.from(table).select('*');
    for (const [operator, column, value] of filters) {
      query = query[operator](column, value);
    }
    return rows(await execute(`${table}.select`, query), `${table}.select`);
  }

  async function selectOne(table, filters) {
    const found = await selectRows(table, filters);
    if (found.length > 1) throw unavailable(`${table}.ambiguous`);
    return found[0] || null;
  }

  async function insertRow(table, row) {
    await execute(`${table}.insert`, db.from(table).insert(row));
  }

  // insertIfAbsent requires the conflict target (the table's primary key) so the
  // SDK can emit ON CONFLICT DO NOTHING; .select() returns the inserted row, or
  // an empty array when the key already existed.
  const CONFLICT_KEYS = {
    ai_budget: 'window_start',
    ai_issuance: 'ip_hash,window_start',
    ai_visitor_usage: 'visitor_hash,window_start',
    ai_usage_log: 'reservation',
    ai_resource_bindings: 'binding_key',
  };

  async function insertIfAbsent(table, row) {
    const onConflict = CONFLICT_KEYS[table];
    return execute(`${table}.insertIfAbsent`, db.from(table).insertIfAbsent(row, { onConflict }).select('*'));
  }

  async function ensureRow(table, row, filters) {
    const inserted = await insertIfAbsent(table, row);
    if (rows(inserted, `${table}.insertIfAbsent`).length > 0) return row;
    const existing = await selectOne(table, filters);
    if (!existing) throw unavailable(`${table}.initialize`);
    return existing;
  }

  async function casUpdate(table, filters, patch, expectedVersion) {
    const nextPatch = { ...patch, record_version: expectedVersion + 1 };
    let query = db.from(table).update(nextPatch);
    for (const [operator, column, value] of filters) query = query[operator](column, value);
    query = query.eq('record_version', expectedVersion).select();
    const affected = rows(await execute(`${table}.update`, query), `${table}.update`);
    if (affected.length > 1) throw unavailable(`${table}.ambiguous_update`);
    return affected[0] || null;
  }

  function timestamp() {
    const value = now();
    if (!Number.isFinite(value)) throw new Error('quota_clock_invalid');
    return value;
  }

  async function budgetRow(windowStart) {
    return ensureRow('ai_budget', {
      window_start: windowStart,
      daily_budget_credits: config.dailyBudgetCredits,
      reserve_credits: config.reserveCredits,
      spent_credits: 0,
      reserved_credits: 0,
      active_reservations: {},
      blocked: false,
      blocked_reason: null,
      record_version: 0,
      updated_at: isoTime(timestamp()),
    }, [['eq', 'window_start', windowStart]]);
  }

  async function releaseGlobal(reservationId, windowStart) {
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
      const row = await selectOne('ai_budget', [['eq', 'window_start', windowStart]]);
      if (!row) return false;
      const active = reservationMap(row.active_reservations);
      const entry = active[reservationId];
      if (!entry) return false;
      const nextActive = { ...active };
      delete nextActive[reservationId];
      const credits = dbInteger(entry.credits, 'reservation_credits');
      const updated = await casUpdate('ai_budget', [['eq', 'window_start', windowStart]], {
        reserved_credits: Math.max(0, dbInteger(row.reserved_credits, 'reserved_credits') - credits),
        active_reservations: nextActive,
        updated_at: isoTime(timestamp()),
      }, dbInteger(row.record_version, 'record_version'));
      if (updated) return true;
    }
    throw unavailable('ai_budget.release_contention');
  }

  async function expireReservation(reservationId) {
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
      const row = await selectOne('ai_reservations', [['eq', 'reservation_id', reservationId]]);
      if (!row || TERMINAL_RESERVATION_STATES.has(row.status)) return;
      const updated = await casUpdate('ai_reservations', [['eq', 'reservation_id', reservationId]], {
        status: 'expired',
        updated_at: isoTime(timestamp()),
        settled_at: isoTime(timestamp()),
      }, dbInteger(row.record_version, 'record_version'));
      if (updated) return;
    }
    throw unavailable('ai_reservations.expire_contention');
  }

  async function cleanup(windowStart) {
    const cutoff = timestamp() - RESERVATION_TTL_MS;
    const cutoffIso = isoTime(cutoff);
    const windowFilter = windowStart ? [['eq', 'window_start', windowStart]] : [];
    const budgets = await selectRows('ai_budget', windowFilter);
    for (const row of budgets) {
      const active = reservationMap(row.active_reservations);
      for (const [reservationId, entry] of Object.entries(active)) {
        const created = Date.parse(entry?.created_at);
        if (Number.isFinite(created) && created > cutoff) continue;
        // A crash can leave a paid request unreported. Consume its entire
        // allowance in the ledger without recording it as actual provider usage.
        const reservedCredits = dbInteger(entry.credits, 'reservation_credits');
        await applySettlement({
          reservation_id: reservationId, window_start: row.window_start, reserved_credits: reservedCredits,
        }, reservedCredits);
        await expireReservation(reservationId);
      }
    }
    // Also expires intents left behind by a crash before the budget ledger write.
    const stale = await selectRows('ai_reservations', [...windowFilter, ['eq', 'status', 'pending'], ['lte', 'created_at', cutoffIso]]);
    for (const row of stale) {
      if (!TERMINAL_RESERVATION_STATES.has(row.status)) await expireReservation(row.reservation_id);
    }
    return { ok: true, cutoff: cutoffIso };
  }

  async function issue({ ipHash }) {
    const hash = safeText(ipHash, 'ip_hash');
    const windowStart = utcWindow(timestamp());
    await ensureRow('ai_issuance', {
      ip_hash: hash,
      window_start: windowStart,
      issue_count: 0,
      record_version: 0,
      updated_at: isoTime(timestamp()),
    }, [['eq', 'ip_hash', hash], ['eq', 'window_start', windowStart]]);

    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
      const row = await selectOne('ai_issuance', [
        ['eq', 'ip_hash', hash], ['eq', 'window_start', windowStart],
      ]);
      if (!row) throw unavailable('ai_issuance.missing');
      const count = dbInteger(row.issue_count, 'issue_count');
      if (count >= config.issueMaxPerIp) {
        throw quotaError('ai_issue_rate_limited', 'Too many visitor tickets issued.', 429);
      }
      const updated = await casUpdate('ai_issuance', [
        ['eq', 'ip_hash', hash], ['eq', 'window_start', windowStart],
      ], {
        issue_count: count + 1,
        updated_at: isoTime(timestamp()),
      }, dbInteger(row.record_version, 'record_version'));
      if (updated) return { ok: true, windowStart, remaining: config.issueMaxPerIp - count - 1 };
    }
    throw unavailable('ai_issuance.contention');
  }

  async function addGlobalReservation(reservation) {
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
      const row = await budgetRow(reservation.window_start);
      if (row.blocked === true) {
        throw quotaError('ai_budget_blocked', 'The AI budget is blocked.', 429);
      }
      const reserved = dbInteger(row.reserved_credits, 'reserved_credits');
      const spent = dbInteger(row.spent_credits, 'spent_credits');
      const daily = Math.min(dbInteger(row.daily_budget_credits, 'daily_budget_credits'), config.dailyBudgetCredits);
      if (spent + reserved + reservation.reserved_credits > daily) {
        throw quotaError('ai_quota_exceeded', 'The daily AI budget is exhausted.', 429);
      }
      const active = reservationMap(row.active_reservations);
      if (Object.prototype.hasOwnProperty.call(active, reservation.reservation_id)) {
        throw unavailable('ai_budget.duplicate_reservation');
      }
      const updated = await casUpdate('ai_budget', [['eq', 'window_start', reservation.window_start]], {
        reserved_credits: reserved + reservation.reserved_credits,
        active_reservations: {
          ...active,
          [reservation.reservation_id]: {
            credits: reservation.reserved_credits,
            created_at: reservation.created_at,
          },
        },
        updated_at: isoTime(timestamp()),
      }, dbInteger(row.record_version, 'record_version'));
      if (updated) return updated;
    }
    throw unavailable('ai_budget.reserve_contention');
  }

  async function addVisitorReservation(visitorHash, windowStart) {
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
      const row = await ensureRow('ai_visitor_usage', {
        visitor_hash: visitorHash,
        window_start: windowStart,
        request_count: 0,
        record_version: 0,
        updated_at: isoTime(timestamp()),
      }, [['eq', 'visitor_hash', visitorHash], ['eq', 'window_start', windowStart]]);
      const count = dbInteger(row.request_count, 'request_count');
      if (count >= config.visitorMaxRequests) {
        throw quotaError('ai_visitor_quota_exceeded', 'The visitor request limit is exhausted.', 429);
      }
      const updated = await casUpdate('ai_visitor_usage', [
        ['eq', 'visitor_hash', visitorHash], ['eq', 'window_start', windowStart],
      ], {
        request_count: count + 1,
        updated_at: isoTime(timestamp()),
      }, dbInteger(row.record_version, 'record_version'));
      if (updated) return updated;
    }
    throw unavailable('ai_visitor_usage.contention');
  }

  async function removeVisitorReservation(visitorHash, windowStart) {
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
      const row = await selectOne('ai_visitor_usage', [
        ['eq', 'visitor_hash', visitorHash], ['eq', 'window_start', windowStart],
      ]);
      if (!row) return;
      const updated = await casUpdate('ai_visitor_usage', [
        ['eq', 'visitor_hash', visitorHash], ['eq', 'window_start', windowStart],
      ], {
        request_count: Math.max(0, dbInteger(row.request_count, 'request_count') - 1),
        updated_at: isoTime(timestamp()),
      }, dbInteger(row.record_version, 'record_version'));
      if (updated) return;
    }
    throw unavailable('ai_visitor_usage.release_contention');
  }

  async function markReservation(reservation, status, extra = {}) {
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
      const current = await selectOne('ai_reservations', [['eq', 'reservation_id', reservation.reservation_id]]);
      if (!current) throw unavailable('ai_reservations.missing');
      if (TERMINAL_RESERVATION_STATES.has(current.status)) return current;
      const updated = await casUpdate('ai_reservations', [['eq', 'reservation_id', reservation.reservation_id]], {
        status,
        ...extra,
        updated_at: isoTime(timestamp()),
      }, dbInteger(current.record_version, 'record_version'));
      if (updated) return updated;
    }
    throw unavailable('ai_reservations.transition_contention');
  }

  async function reserve({ visitorId, action }) {
    const visitorHash = safeText(visitorId, 'visitor_id');
    const actionName = safeText(action, 'action', { max: 64 });
    const windowStart = utcWindow(timestamp());
    await cleanup(windowStart);
    const createdAt = isoTime(timestamp());
    const reservation = {
      reservation_id: crypto.randomUUID(),
      window_start: windowStart,
      visitor_hash: visitorHash,
      action: actionName,
      reserved_credits: config.reserveCredits,
      actual_credits: null,
      status: 'pending',
      request_id: null,
      model: null,
      duration_ms: null,
      budget_record_version: null,
      created_at: createdAt,
      updated_at: createdAt,
      settled_at: null,
      record_version: 0,
    };
    await insertRow('ai_reservations', reservation);

    let globalReserved = false;
    let visitorReserved = false;
    try {
      const budget = await addGlobalReservation(reservation);
      globalReserved = true;
      reservation.budget_record_version = budget.record_version;
      await addVisitorReservation(visitorHash, windowStart);
      visitorReserved = true;
      const active = await markReservation(reservation, 'reserved', {
        budget_record_version: budget.record_version,
      });
      if (active.status !== 'reserved') throw unavailable('ai_reservations.not_active');
      return publicReservation(active);
    } catch (error) {
      try {
        if (globalReserved) await releaseGlobal(reservation.reservation_id, windowStart);
        if (visitorReserved) await removeVisitorReservation(visitorHash, windowStart);
        await markReservation(reservation, 'released', { settled_at: isoTime(timestamp()) });
      } catch (releaseError) {
        diagnostic('ai_quota_release_failed', 'reserve.rollback', releaseError);
        throw unavailable('reserve.rollback');
      }
      throw error;
    }
  }

  async function blockBudget(windowStart, reason) {
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
      const row = await budgetRow(windowStart);
      if (row.blocked === true) return row;
      const updated = await casUpdate('ai_budget', [['eq', 'window_start', windowStart]], {
        blocked: true,
        blocked_reason: reason,
        updated_at: isoTime(timestamp()),
      }, dbInteger(row.record_version, 'record_version'));
      if (updated) return updated;
    }
    throw unavailable('ai_budget.block_contention');
  }

  async function applySettlement(reservation, actualCredits) {
    const overReserve = actualCredits > reservation.reserved_credits;
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
      const row = await budgetRow(reservation.window_start);
      const active = reservationMap(row.active_reservations);
      const entry = active[reservation.reservation_id];
      if (!entry) {
        if (overReserve) return blockBudget(reservation.window_start, 'actual_exceeded_reserve');
        return row;
      }
      const heldCredits = dbInteger(entry.credits, 'reservation_credits');
      // An upstream overrun cannot be undone. Charge only the authorized hold
      // to keep spent + reserved within the hard cap, log the full actual value,
      // and block all later calls in this UTC budget window.
      const chargedCredits = overReserve ? heldCredits : actualCredits;
      const nextActive = { ...active };
      delete nextActive[reservation.reservation_id];
      const updated = await casUpdate('ai_budget', [['eq', 'window_start', reservation.window_start]], {
        spent_credits: dbInteger(row.spent_credits, 'spent_credits') + chargedCredits,
        reserved_credits: Math.max(0, dbInteger(row.reserved_credits, 'reserved_credits') - heldCredits),
        active_reservations: nextActive,
        blocked: overReserve || row.blocked === true,
        blocked_reason: overReserve ? 'actual_exceeded_reserve' : row.blocked_reason,
        updated_at: isoTime(timestamp()),
      }, dbInteger(row.record_version, 'record_version'));
      if (updated) return updated;
    }
    throw unavailable('ai_budget.settle_contention');
  }

  async function writeUsageLog(reservation, details, actualCredits, createdAt) {
    const row = {
      reservation: reservation.reservation_id,
      request_id: details.requestId,
      action: reservation.action,
      status: details.status,
      usage_status: actualCredits === null ? '未返回' : 'returned',
      model: details.model,
      duration_ms: details.durationMs,
      credits: actualCredits,
      visitor_hash: reservation.visitor_hash,
      created_at: createdAt,
    };
    // reservation is the primary key, so a retry cannot double-log or charge.
    await insertIfAbsent('ai_usage_log', row);
  }

  async function settle(reservationInput, details = {}) {
    const reservationId = safeText(
      reservationInput?.reservation_id ?? reservationInput?.reservationId ?? reservationInput?.id,
      'reservation_id',
    );
    const actualCredits = details.actualCredits === null || details.actualCredits === undefined
      ? null : creditAmount(details.actualCredits, 'actual_credits');
    const status = details.status === null || details.status === undefined
      ? 'unknown' : safeText(details.status, 'status', { max: 64 });
    const requestId = safeText(details.requestId, 'request_id', { max: 256, nullable: true });
    const model = safeText(details.model, 'model', { max: 256, nullable: true });
    const durationMs = details.durationMs === null || details.durationMs === undefined
      ? null : creditAmount(details.durationMs, 'duration_ms');
    const reservation = await selectOne('ai_reservations', [['eq', 'reservation_id', reservationId]]);
    if (!reservation) throw unavailable('ai_reservations.missing');
    const createdAt = isoTime(timestamp());
    let budget = null;

    if (TERMINAL_RESERVATION_STATES.has(reservation.status)) {
      if (actualCredits !== null && actualCredits > reservation.reserved_credits
        && reservation.status === 'expired') {
        budget = await blockBudget(reservation.window_start, 'actual_exceeded_reserve');
      }
    } else if (actualCredits === null) {
      // Keep the full allowance held until cleanup conservatively accounts for it.
      await markReservation(reservation, 'usage_missing', {
        request_id: requestId,
        model,
        duration_ms: durationMs,
        actual_credits: null,
        settled_at: null,
      });
    } else {
      budget = await applySettlement(reservation, actualCredits);
      await markReservation(reservation, actualCredits > reservation.reserved_credits ? 'budget_blocked' : 'settled', {
        request_id: requestId,
        model,
        duration_ms: durationMs,
        actual_credits: actualCredits,
        settled_at: createdAt,
      });
    }

    await writeUsageLog(reservation, { status, requestId, model, durationMs }, actualCredits, createdAt);
    return {
      ok: true,
      reservationId,
      status: actualCredits === null ? 'usage_missing' : reservation.status,
      actualCredits,
      budgetBlocked: budget?.blocked === true,
    };
  }

  function createCoordinator() {
    async function acquire(key) {
      const bindingKey = safeText(key, 'binding_key', { max: 256 });
      const owner = crypto.randomUUID();
      const acquiredAt = timestamp();
      const leaseExpiresAt = isoTime(acquiredAt + LEASE_MS);
      await ensureRow('ai_resource_bindings', {
        binding_key: bindingKey,
        binding: null,
        owner,
        // Initialization is not ownership. The CAS below must acquire it.
        lease_expires_at: isoTime(acquiredAt),
        record_version: 0,
        updated_at: isoTime(acquiredAt),
      }, [['eq', 'binding_key', bindingKey]]);

      for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
        const row = await selectOne('ai_resource_bindings', [['eq', 'binding_key', bindingKey]]);
        if (!row) throw unavailable('ai_resource_bindings.missing');
        const expiresAt = Date.parse(row.lease_expires_at);
        if (Number.isFinite(expiresAt) && expiresAt > timestamp()) {
          throw quotaError('ai_resource_lock_busy', 'Another instance holds the resource lock.', 409);
        }
        const updated = await casUpdate('ai_resource_bindings', [['eq', 'binding_key', bindingKey]], {
          owner,
          lease_expires_at: leaseExpiresAt,
          updated_at: isoTime(timestamp()),
        }, dbInteger(row.record_version, 'record_version'));
        if (!updated) continue;
        let version = dbInteger(updated.record_version, 'record_version');

        async function assertHeld() {
          const current = await selectOne('ai_resource_bindings', [['eq', 'binding_key', bindingKey]]);
          if (!current || current.owner !== owner
            || dbInteger(current.record_version, 'record_version') !== version
            || !(Date.parse(current.lease_expires_at) > timestamp())) {
            throw quotaError('ai_resource_lease_lost', 'The resource lease is no longer held.', 409);
          }
          return true;
        }

        async function read() {
          await assertHeld();
          const current = await selectOne('ai_resource_bindings', [['eq', 'binding_key', bindingKey]]);
          if (!current || current.owner !== owner
            || dbInteger(current.record_version, 'record_version') !== version
            || !(Date.parse(current.lease_expires_at) > timestamp())) {
            throw quotaError('ai_resource_lease_lost', 'The resource lease is no longer held.', 409);
          }
          return current.binding == null ? null : JSON.parse(JSON.stringify(current.binding));
        }

        async function write(binding) {
          await assertHeld();
          let encoded;
          try { encoded = JSON.stringify(binding); } catch { throw new Error('resource_binding_invalid'); }
          if (encoded === undefined) throw new Error('resource_binding_invalid');
          const updatedBinding = await casUpdate('ai_resource_bindings', [['eq', 'binding_key', bindingKey]], {
            binding: JSON.parse(encoded),
            updated_at: isoTime(timestamp()),
          }, version);
          if (!updatedBinding) {
            throw quotaError('ai_resource_lease_lost', 'The resource lease was fenced.', 409);
          }
          version = dbInteger(updatedBinding.record_version, 'record_version');
          return JSON.parse(encoded);
        }

        async function release() {
          const current = await selectOne('ai_resource_bindings', [['eq', 'binding_key', bindingKey]]);
          if (!current || current.owner !== owner
            || dbInteger(current.record_version, 'record_version') !== version) return;
          await casUpdate('ai_resource_bindings', [['eq', 'binding_key', bindingKey]], {
            lease_expires_at: isoTime(timestamp()),
            updated_at: isoTime(timestamp()),
          }, version);
        }

        return { read, write, assertHeld, release, owner, version };
      }
      throw unavailable('ai_resource_bindings.acquire_contention');
    }

    async function withLock(key, callback) {
      if (typeof callback !== 'function') throw new Error('quota_lock_callback_invalid');
      const lease = await acquire(key);
      try {
        return await callback(lease);
      } finally {
        try { await lease.release(); } catch (error) { diagnostic('ai_resource_lock_release_failed', 'lock.release', error); }
      }
    }

    return { withLock };
  }

  return { issue, reserve, settle, cleanup, coordinator: createCoordinator() };
}
