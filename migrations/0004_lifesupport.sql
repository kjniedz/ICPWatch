-- Life support (phase 4): settings, caps, kill switch, idempotency, lease, and the append-only audit log.
-- Depends only on 0001 (life_support, topup_log). Safe defaults: kill switch ENGAGED, caps small.
-- The database itself enforces the hard limits, so a bug in the Worker cannot overspend:
--   * CHECK: global_spent_cycles can never exceed global_cap_cycles
--   * trigger: spend cannot be recorded while the kill switch is engaged
--   * trigger: per-canister spent_cycles can never exceed budget_cycles, and only 'active' rows can spend
--   * UNIQUE: one live attempt per canister per UTC day
--   * triggers: an attempt row needs an actively enrolled canister and a released kill switch
--   * triggers: ls_audit, ls_attempts, and topup_log reject UPDATE and DELETE (append-only)
-- The engine reserves spend (all of the above, in ONE batch = one transaction) BEFORE any ICP moves.

CREATE TABLE ls_settings (
  id                       INTEGER PRIMARY KEY CHECK (id = 1),
  kill_switch              INTEGER NOT NULL DEFAULT 1 CHECK (kill_switch IN (0, 1)),
  kill_reason              TEXT,
  global_cap_cycles        INTEGER NOT NULL DEFAULT 1000000000000 CHECK (global_cap_cycles >= 0),  -- 1 T, about 1 XDR
  global_spent_cycles      INTEGER NOT NULL DEFAULT 0 CHECK (global_spent_cycles >= 0),
  daily_cap_cycles         INTEGER NOT NULL DEFAULT 250000000000 CHECK (daily_cap_cycles >= 0),    -- rolling 24 h
  max_single_topup_cycles  INTEGER NOT NULL DEFAULT 100000000000 CHECK (max_single_topup_cycles >= 0),
  max_topups_per_tick      INTEGER NOT NULL DEFAULT 3,
  max_reading_age_s        INTEGER NOT NULL DEFAULT 7200,
  min_interval_s           INTEGER NOT NULL DEFAULT 172800,
  params                   TEXT,                       -- json: optional PlannerParams overrides
  last_xdr_permyriad       INTEGER,                    -- last accepted CMC rate, sanity anchor for the next one
  last_xdr_at              INTEGER,
  updated_at               INTEGER NOT NULL,
  updated_by               TEXT NOT NULL,
  CHECK (global_spent_cycles <= global_cap_cycles)
);
INSERT INTO ls_settings (id, kill_switch, kill_reason, updated_at, updated_by)
VALUES (1, 1, 'engaged by default: life support has never been enabled', CAST(strftime('%s', 'now') AS INTEGER), 'migration');

CREATE TRIGGER ls_settings_kill_guard BEFORE UPDATE OF global_spent_cycles ON ls_settings
WHEN NEW.global_spent_cycles > OLD.global_spent_cycles AND (OLD.kill_switch = 1 OR NEW.kill_switch = 1)
BEGIN SELECT RAISE(ABORT, 'life support: kill switch engaged'); END;

CREATE TRIGGER ls_settings_no_delete BEFORE DELETE ON ls_settings
BEGIN SELECT RAISE(ABORT, 'life support: settings row cannot be deleted'); END;

CREATE TRIGGER ls_budget_guard BEFORE UPDATE OF spent_cycles ON life_support
WHEN NEW.spent_cycles > OLD.spent_cycles AND (NEW.spent_cycles > NEW.budget_cycles OR NEW.state <> 'active')
BEGIN SELECT RAISE(ABORT, 'life support: canister budget exceeded or not active'); END;

-- Idempotency: at most one live attempt per canister per UTC day, whatever the cron does.
CREATE TABLE ls_attempts (
  attempt_id   TEXT PRIMARY KEY,
  canister_id  TEXT NOT NULL,
  period_key   TEXT NOT NULL,                          -- UTC day, YYYY-MM-DD
  ts           INTEGER NOT NULL,
  cost_cycles  INTEGER NOT NULL CHECK (cost_cycles > 0)
);
CREATE UNIQUE INDEX ls_attempts_period ON ls_attempts (canister_id, period_key);

-- An attempt can only exist for an actively enrolled canister, and never while the kill switch is engaged.
CREATE TRIGGER ls_attempts_enrolled_guard BEFORE INSERT ON ls_attempts
WHEN NOT EXISTS (SELECT 1 FROM life_support WHERE canister_id = NEW.canister_id AND state = 'active')
BEGIN SELECT RAISE(ABORT, 'life support: canister is not actively enrolled'); END;

CREATE TRIGGER ls_attempts_kill_guard BEFORE INSERT ON ls_attempts
WHEN (SELECT kill_switch FROM ls_settings WHERE id = 1) <> 0
BEGIN SELECT RAISE(ABORT, 'life support: kill switch engaged'); END;

-- Tick lease: two overlapping cron invocations cannot both run the funded path.
CREATE TABLE ls_lease (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  holder      TEXT,
  expires_at  INTEGER NOT NULL DEFAULT 0
);
INSERT INTO ls_lease (id, holder, expires_at) VALUES (1, NULL, 0);

-- Append-only audit log. One row per stage, linked by attempt_id. Dry-run plans and refusals are logged too.
CREATE TABLE ls_audit (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                 INTEGER NOT NULL,
  attempt_id         TEXT,
  canister_id        TEXT,                             -- null for admin rows
  mode               TEXT NOT NULL,                    -- dry_run | live | admin
  stage              TEXT NOT NULL,                    -- plan | reserve | transfer | notify | verify | release | anomaly | recover | admin
  code               TEXT NOT NULL,                    -- planner code or stage result
  ok                 INTEGER NOT NULL,
  amount_cycles      INTEGER,
  cost_cycles        INTEGER,                          -- amount + ledger fee in cycles: what caps are charged
  icp_e8s            INTEGER,
  fee_e8s            INTEGER,
  xdr_permyriad      INTEGER,
  before_cycles      INTEGER,
  threshold_cycles   INTEGER,
  idle_burn_per_day  INTEGER,
  low_water          INTEGER,
  high_water         INTEGER,
  reading_source     TEXT,
  reading_ts         INTEGER,
  after_cycles       INTEGER,
  after_frozen       INTEGER,
  ledger_block       INTEGER,                          -- ICP ledger block index of the transfer
  minted_cycles      INTEGER,
  plan               TEXT,                             -- json of the full plan
  note               TEXT
);
CREATE INDEX ls_audit_canister ON ls_audit (canister_id, ts DESC);
CREATE INDEX ls_audit_attempt ON ls_audit (attempt_id);
CREATE INDEX ls_audit_stage ON ls_audit (stage, ts DESC);

CREATE TRIGGER ls_audit_no_update BEFORE UPDATE ON ls_audit BEGIN SELECT RAISE(ABORT, 'ls_audit is append-only'); END;
CREATE TRIGGER ls_audit_no_delete BEFORE DELETE ON ls_audit BEGIN SELECT RAISE(ABORT, 'ls_audit is append-only'); END;
CREATE TRIGGER ls_attempts_no_update BEFORE UPDATE ON ls_attempts BEGIN SELECT RAISE(ABORT, 'ls_attempts is append-only'); END;
CREATE TRIGGER ls_attempts_no_delete BEFORE DELETE ON ls_attempts BEGIN SELECT RAISE(ABORT, 'ls_attempts is append-only'); END;
CREATE TRIGGER topup_log_no_update BEFORE UPDATE ON topup_log BEGIN SELECT RAISE(ABORT, 'topup_log is append-only'); END;
CREATE TRIGGER topup_log_no_delete BEFORE DELETE ON topup_log BEGIN SELECT RAISE(ABORT, 'topup_log is append-only'); END;
