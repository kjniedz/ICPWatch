-- SNS proposals and neurons, paged from each DAO's governance canister.

CREATE TABLE sns_proposals (
  token_id      TEXT NOT NULL,               -- ledger id of the SNS token (the registry key)
  id            INTEGER NOT NULL,
  action        INTEGER NOT NULL,            -- native action id, 1000+ are custom functions
  type          TEXT NOT NULL,               -- readable action name
  title         TEXT,
  summary       TEXT,
  url           TEXT,
  state         TEXT NOT NULL,               -- open | rejected | adopted | executed | failed
  yes           REAL, no REAL, total REAL,   -- voting power, e8s scaled to tokens
  created_at    INTEGER,
  decided_at    INTEGER,
  executed_at   INTEGER,
  deadline_at   INTEGER,
  -- treasury movements: TransferSnsTreasuryFunds (9) and MintSnsTokens (12)
  treasury_kind TEXT,                        -- icp | token | mint | NULL
  treasury_amount REAL,                      -- token units
  treasury_to   TEXT,                        -- destination account text
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (token_id, id)
) WITHOUT ROWID;
CREATE INDEX sns_proposals_open ON sns_proposals (state, created_at DESC);
CREATE INDEX sns_proposals_time ON sns_proposals (created_at DESC);
CREATE INDEX sns_proposals_treasury ON sns_proposals (treasury_kind, created_at DESC);

CREATE TABLE sns_neurons (
  token_id      TEXT NOT NULL,
  neuron_id     TEXT NOT NULL,               -- hex; also the governance subaccount holding the stake
  controller    TEXT,                        -- principal with the full permission set, NULL when none
  stake         REAL NOT NULL,               -- tokens (cached stake plus staked maturity)
  maturity      REAL NOT NULL DEFAULT 0,
  dissolve_delay_s INTEGER,                  -- when not dissolving
  dissolved_at  INTEGER,                     -- unix seconds when dissolving
  vesting_ends_at INTEGER,                   -- created_at + vesting period, for developer neurons
  vp_multiplier INTEGER NOT NULL DEFAULT 100,
  from_nns_fund INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER,
  seen_at       INTEGER NOT NULL,
  PRIMARY KEY (token_id, neuron_id)
) WITHOUT ROWID;
CREATE INDEX sns_neurons_controller ON sns_neurons (controller);
CREATE INDEX sns_neurons_unlock ON sns_neurons (dissolved_at);
CREATE INDEX sns_neurons_vesting ON sns_neurons (vesting_ends_at);

-- Paging cursor and totals per DAO for the neuron walk.
CREATE TABLE sns_neuron_state (
  token_id      TEXT PRIMARY KEY,
  cursor        TEXT,                        -- last neuron id of the current pass, NULL between passes
  pass_started  INTEGER,
  pass_done     INTEGER,                     -- when the last full pass finished
  neurons       INTEGER NOT NULL DEFAULT 0,
  staked        REAL NOT NULL DEFAULT 0,
  error         TEXT,
  updated_at    INTEGER NOT NULL
);

-- Swap facts and lifecycle per SNS (raised, participants, live progress).
CREATE TABLE sns_swaps (
  token_id      TEXT PRIMARY KEY,
  swap_id       TEXT NOT NULL,
  lifecycle     INTEGER,                     -- 1 pending, 2 open, 3 committed, 4 aborted, 5 adopted
  opens_at      INTEGER,
  closed_at     INTEGER,
  icp_raised    REAL,                        -- ICP, buyer total
  direct_icp    REAL,
  nf_icp        REAL,
  tokens_per_icp REAL,
  participants  INTEGER,
  max_icp       REAL,                        -- swap target when exposed
  min_icp       REAL,
  updated_at    INTEGER NOT NULL
);

-- Daily holder snapshot per indexed ledger, for holder count over time and new versus exiting holders.
CREATE TABLE holder_daily (
  ledger        TEXT NOT NULL,
  day           INTEGER NOT NULL,
  holders       INTEGER NOT NULL,
  new_holders   INTEGER NOT NULL DEFAULT 0,
  exited        INTEGER NOT NULL DEFAULT 0,
  top10_share   REAL,
  gini          REAL,
  nakamoto      INTEGER,
  PRIMARY KEY (ledger, day)
) WITHOUT ROWID;
