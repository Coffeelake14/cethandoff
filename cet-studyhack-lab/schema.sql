-- Credits are non-negative integer credit units. Callers round fractional
-- upstream credits up before settlement so a reservation is never understated.
-- All column values are supplied by the Function; the platform migration subset
-- does not support DEFAULT/CHECK/foreign keys/generated columns.
CREATE TABLE app.ai_budget (
  window_start text PRIMARY KEY,
  daily_budget_credits bigint NOT NULL,
  reserve_credits bigint NOT NULL,
  spent_credits bigint NOT NULL,
  reserved_credits bigint NOT NULL,
  active_reservations jsonb NOT NULL,
  blocked boolean NOT NULL,
  blocked_reason text,
  record_version bigint NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE app.ai_visitor_usage (
  visitor_hash text NOT NULL,
  window_start text NOT NULL,
  request_count bigint NOT NULL,
  record_version bigint NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (visitor_hash, window_start)
);

CREATE TABLE app.ai_issuance (
  ip_hash text NOT NULL,
  window_start text NOT NULL,
  issue_count bigint NOT NULL,
  record_version bigint NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (ip_hash, window_start)
);

CREATE TABLE app.ai_reservations (
  reservation_id uuid PRIMARY KEY,
  window_start text NOT NULL,
  visitor_hash text NOT NULL,
  action text NOT NULL,
  reserved_credits bigint NOT NULL,
  actual_credits bigint,
  status text NOT NULL,
  request_id text,
  model text,
  duration_ms bigint,
  budget_record_version bigint,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  settled_at timestamptz,
  record_version bigint NOT NULL
);

CREATE TABLE app.ai_usage_log (
  reservation uuid PRIMARY KEY,
  request_id text,
  action text NOT NULL,
  status text NOT NULL,
  usage_status text NOT NULL,
  model text,
  duration_ms bigint,
  credits bigint,
  visitor_hash text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE app.ai_resource_bindings (
  binding_key text PRIMARY KEY,
  binding jsonb,
  owner text NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  record_version bigint NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX ai_reservations_expiry_idx
  ON app.ai_reservations (created_at, status);
CREATE INDEX ai_reservations_visitor_idx
  ON app.ai_reservations (visitor_hash, window_start);
CREATE INDEX ai_usage_log_created_idx
  ON app.ai_usage_log (created_at);
CREATE INDEX ai_usage_log_visitor_idx
  ON app.ai_usage_log (visitor_hash, created_at);
CREATE INDEX ai_issuance_window_idx
  ON app.ai_issuance (window_start);
CREATE INDEX ai_resource_bindings_expiry_idx
  ON app.ai_resource_bindings (lease_expires_at);