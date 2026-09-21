-- ICPWatch core schema.
-- Conventions: all timestamps are unix seconds (INTEGER). Cycles are INTEGER (SQLite int64).
-- Every stored number carries a source and a fetched-at timestamp so the UI can show provenance.

-- A token is a group of canisters: ledger + index + archives (+ SNS canisters where relevant).
CREATE TABLE tokens (
  id            TEXT PRIMARY KEY,            -- ledger canister id
  symbol        TEXT NOT NULL,
  name          TEXT NOT NULL,
  decimals      INTEGER NOT NULL DEFAULT 8,
  fee           TEXT,
  kind          TEXT NOT NULL,               -- native | ck | sns | community
  standard      TEXT NOT NULL DEFAULT 'icrc1',
  sns_root      TEXT,
  logo          TEXT,                        -- url or path under /logo/
  description   TEXT,
  url           TEXT,
  total_supply  TEXT,                        -- base units, as text (nat)
  supply_at     INTEGER,
  listed_at     INTEGER NOT NULL,
  listed_via    TEXT NOT NULL,               -- sns-aggregator | seed | dex:<name> | request
  hidden        INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX tokens_symbol ON tokens (symbol COLLATE NOCASE);
CREATE INDEX tokens_kind ON tokens (kind);

-- Every canister Lifeline watches, with its latest denormalized state for fast listing.
CREATE TABLE canisters (
  id                    TEXT PRIMARY KEY,
  token_id              TEXT REFERENCES tokens (id),
  role                  TEXT NOT NULL,       -- ledger | index | archive | root | governance | swap | dapp | minter | orchestrator | other
  label                 TEXT NOT NULL,
  subnet_id             TEXT,
  controllers           TEXT,                -- json array
  module_hash           TEXT,
  discovered_at         INTEGER NOT NULL,
  discovered_via        TEXT NOT NULL,
  -- latest reading
  cycles                INTEGER,
  cycles_source         TEXT,                -- sns-root | nns-root | metrics | blackhole | method | none
  confidence            TEXT NOT NULL DEFAULT 'unknown',  -- measured | inferred | unknown
  run_status            TEXT NOT NULL DEFAULT 'unknown',  -- running | stopping | stopped | frozen | out_of_cycles | no_wasm | deleted | unknown
  freezing_threshold_s  INTEGER,
  idle_burn_per_day     INTEGER,
  memory_bytes          INTEGER,
  -- derived
  burn_per_day          INTEGER,             -- observed from our own readings
  burn_baseline         INTEGER,             -- rolling median of daily burn (own history)
  burn_mad              INTEGER,             -- median absolute deviation of daily burn
  baseline_days         INTEGER,             -- days of history behind the baseline
  source_hint           TEXT,                -- which source last worked: sns-root | nns-root | metrics | blackhole | probe
  sns_root              TEXT,                -- SNS root that can report this canister's status
  burn_source           TEXT,                -- observed | idle | none
  freeze_at             INTEGER,             -- projected
  delete_at             INTEGER,             -- projected
  health                TEXT NOT NULL DEFAULT 'unknown',  -- healthy | low | risk | frozen | life | unknown | gone
  measured_at           INTEGER,
  probed_at             INTEGER,
  life_support          INTEGER NOT NULL DEFAULT 0,
  note                  TEXT
);
CREATE INDEX canisters_token ON canisters (token_id);
CREATE INDEX canisters_health ON canisters (health);
CREATE INDEX canisters_role ON canisters (role);

-- Raw time series. Rolled up by the nightly job: raw 14d, hourly 120d, daily forever.
CREATE TABLE readings (
  canister_id   TEXT NOT NULL,
  ts            INTEGER NOT NULL,
  cycles        INTEGER,
  source        TEXT NOT NULL,
  confidence    TEXT NOT NULL,
  run_status    TEXT,
  memory_bytes  INTEGER,
  res           TEXT NOT NULL DEFAULT 'raw', -- raw | hour | day
  PRIMARY KEY (canister_id, ts)
) WITHOUT ROWID;

-- One row per canister per UTC day, written by the nightly rollup. Feeds the anomaly baseline.
CREATE TABLE daily_burn (
  canister_id   TEXT NOT NULL,
  day           INTEGER NOT NULL,            -- unix seconds at 00:00 UTC
  burn          INTEGER NOT NULL,            -- cycles burned per day, top-ups excluded
  PRIMARY KEY (canister_id, day)
) WITHOUT ROWID;

-- Module hash and controller changes (upgrade history as observed by us).
CREATE TABLE canister_changes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  canister_id   TEXT NOT NULL,
  ts            INTEGER NOT NULL,
  field         TEXT NOT NULL,               -- module_hash | controllers
  old_value     TEXT,
  new_value     TEXT
);
CREATE INDEX canister_changes_c ON canister_changes (canister_id, ts DESC);

-- Alerting
CREATE TABLE subscriptions (
  id            TEXT PRIMARY KEY,            -- random token
  channel       TEXT NOT NULL,               -- email | telegram | discord | webhook
  target        TEXT NOT NULL,               -- address, chat id, or url
  scope_type    TEXT NOT NULL,               -- canister | token
  scope_id      TEXT NOT NULL,
  types         TEXT NOT NULL,               -- json array of alert types
  verified      INTEGER NOT NULL DEFAULT 0,
  verify_token  TEXT,
  secret        TEXT,                        -- webhook signing secret
  created_at    INTEGER NOT NULL,
  last_sent_at  INTEGER
);
CREATE INDEX subscriptions_scope ON subscriptions (scope_type, scope_id);
CREATE UNIQUE INDEX subscriptions_unique ON subscriptions (channel, target, scope_type, scope_id);

-- One row per incident. Hysteresis state lives here: an incident opens once, stays open
-- until the recovery condition holds, then resolves once.
CREATE TABLE incidents (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  canister_id   TEXT NOT NULL,
  type          TEXT NOT NULL,               -- low_cycles | frozen | approaching_deletion | burn_anomaly
  state         TEXT NOT NULL,               -- open | resolved
  severity      TEXT NOT NULL,               -- info | warn | critical
  title         TEXT NOT NULL,
  detail        TEXT NOT NULL,
  data          TEXT,                        -- json snapshot of the numbers that tripped it
  opened_at     INTEGER NOT NULL,
  resolved_at   INTEGER,
  clear_streak  INTEGER NOT NULL DEFAULT 0,  -- consecutive clean evaluations (hysteresis)
  simulated     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX incidents_open ON incidents (canister_id, type, state);
CREATE INDEX incidents_time ON incidents (opened_at DESC);

CREATE TABLE notifications (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id     INTEGER NOT NULL,
  subscription_id TEXT NOT NULL,
  kind            TEXT NOT NULL,             -- fired | resolved
  sent_at         INTEGER NOT NULL,
  ok              INTEGER NOT NULL,
  error           TEXT,
  UNIQUE (incident_id, subscription_id, kind)
);

-- Markets
CREATE TABLE market (
  token_id      TEXT PRIMARY KEY,
  price_usd     REAL,
  price_icp     REAL,
  chg_24h       REAL,
  chg_7d        REAL,
  chg_30d       REAL,
  vol_24h_usd   REAL,
  tvl_usd       REAL,
  mcap_usd      REAL,
  fdv_usd       REAL,
  liquidity     TEXT,                        -- json: [{dex, tvl_usd, share}]
  spark_7d      TEXT,                        -- json array of prices
  sources       TEXT,                        -- json array of dex names used
  updated_at    INTEGER NOT NULL
);
CREATE TABLE pools (
  id            TEXT PRIMARY KEY,            -- dex:pool-id
  dex           TEXT NOT NULL,
  token0        TEXT NOT NULL,
  token1        TEXT NOT NULL,
  symbol0       TEXT,
  symbol1       TEXT,
  tvl_usd       REAL,
  vol_24h_usd   REAL,
  vol_7d_usd    REAL,
  fee_bps       REAL,
  price         REAL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX pools_t0 ON pools (token0);
CREATE INDEX pools_t1 ON pools (token1);
CREATE INDEX pools_vol ON pools (vol_24h_usd DESC);
CREATE TABLE prices (
  token_id      TEXT NOT NULL,
  ts            INTEGER NOT NULL,
  price_usd     REAL NOT NULL,               -- close
  open          REAL,
  high          REAL,
  low           REAL,
  vol_usd       REAL,
  res           TEXT NOT NULL,               -- hour | day
  PRIMARY KEY (token_id, res, ts)
) WITHOUT ROWID;

-- Network
CREATE TABLE subnets (
  id              TEXT PRIMARY KEY,
  type            TEXT,
  label           TEXT,
  nodes           INTEGER,
  canisters       INTEGER,
  burn_per_day    REAL,                      -- cycles
  block_rate      REAL,
  msg_rate        REAL,
  instr_rate      REAL,
  memory_bytes    REAL,
  replica_version TEXT,
  updated_at      INTEGER NOT NULL
);
CREATE TABLE proposals (
  id              INTEGER PRIMARY KEY,
  topic           TEXT,
  action          TEXT,
  status          TEXT,
  title           TEXT,
  summary         TEXT,
  url             TEXT,
  proposer        TEXT,
  yes             REAL,
  no              REAL,
  total           REAL,
  created_at      INTEGER,
  deadline_at     INTEGER,
  decided_at      INTEGER,
  executed_at     INTEGER,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX proposals_status ON proposals (status, id DESC);

-- Generic provenance-carrying cache for headline numbers and feeds.
CREATE TABLE kv (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,                 -- json
  source      TEXT NOT NULL,
  fetched_at  INTEGER NOT NULL
);

-- Collector run log: powers /status and freshness indicators.
CREATE TABLE runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job         TEXT NOT NULL,
  started_at  INTEGER NOT NULL,
  ms          INTEGER,
  ok          INTEGER NOT NULL,
  stats       TEXT,
  error       TEXT
);
CREATE INDEX runs_job ON runs (job, started_at DESC);

-- Life support (phase 4). Tables exist now so the registry page and audit log have a home.
CREATE TABLE life_support (
  canister_id     TEXT PRIMARY KEY,
  what            TEXT NOT NULL,
  story           TEXT,
  since           INTEGER NOT NULL,
  budget_cycles   INTEGER NOT NULL,
  spent_cycles    INTEGER NOT NULL DEFAULT 0,
  monthly_cycles  INTEGER,
  state           TEXT NOT NULL DEFAULT 'active', -- active | paused | adopted
  adopted_by      TEXT
);
CREATE TABLE topup_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  canister_id   TEXT NOT NULL,
  ts            INTEGER NOT NULL,
  cycles        INTEGER NOT NULL,
  before_cycles INTEGER,
  after_cycles  INTEGER,
  after_status  TEXT,
  tx            TEXT,
  ok            INTEGER NOT NULL,
  note          TEXT
);

-- Listing and adoption requests from the public forms.
CREATE TABLE requests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,                 -- listing | adopt | contact
  payload     TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
