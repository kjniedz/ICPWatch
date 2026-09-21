-- Block indexer: balances, holder stats, large transfers, and daily activity replayed from
-- ICRC ledger blocks (ledger + archives). Written only by src/indexer/. Timestamps are unix seconds.
-- Exact token amounts are TEXT (base units, arbitrary precision). REAL copies are in whole-token
-- units and exist only for ORDER BY and charts.

-- One row per indexed ledger: the replay cursor and everything needed to resume or back off.
CREATE TABLE idx_state (
  ledger         TEXT PRIMARY KEY,           -- ledger canister id
  next_block     INTEGER NOT NULL DEFAULT 0, -- first block not yet applied. Balances are exact as of block next_block - 1.
  tip            INTEGER NOT NULL DEFAULT 0, -- ledger log_length at the last check
  decimals       INTEGER NOT NULL DEFAULT 8,
  default_fee    TEXT,                       -- icrc1_fee, used only when a block carries no fee
  big_min_raw    TEXT,                       -- threshold (base units) for transfers_big
  holders        INTEGER NOT NULL DEFAULT 0, -- accounts with balance > 0, maintained incrementally
  accounts       INTEGER NOT NULL DEFAULT 0, -- all accounts ever seen
  status         TEXT NOT NULL DEFAULT 'pending', -- pending | syncing | synced | error | unsupported
  error          TEXT,
  fails          INTEGER NOT NULL DEFAULT 0, -- consecutive failures, drives the backoff
  retry_at       INTEGER NOT NULL DEFAULT 0, -- do not touch before this time (backoff)
  next_check_at  INTEGER NOT NULL DEFAULT 0, -- caught-up ledgers are polled adaptively
  last_block_ts  INTEGER,                    -- timestamp of block next_block - 1
  started_at     INTEGER,
  updated_at     INTEGER NOT NULL,
  completed_at   INTEGER                     -- first time the replay reached the tip
);

-- Zero-balance accounts stay (they carry history), holder counts and rankings exclude them.
-- account is the ICRC-1 textual form: "<owner>" for the default subaccount, otherwise
-- "<owner>-<crc32 checksum>.<subaccount hex without leading zeros>".
CREATE TABLE balances (
  ledger       TEXT NOT NULL,
  account      TEXT NOT NULL,
  owner        TEXT NOT NULL,                -- owner principal, for cross-ledger account lookups
  balance      REAL NOT NULL,                -- whole tokens, approximate, for ordering only
  balance_raw  TEXT NOT NULL,                -- exact base units (can be negative for fee collectors, see src/indexer/core.ts)
  tx_count     INTEGER NOT NULL DEFAULT 0,
  first_seen   INTEGER NOT NULL,
  last_active  INTEGER NOT NULL,
  PRIMARY KEY (ledger, account)
) WITHOUT ROWID;
-- Partial: emptied accounts drop out of the index, so rankings stay small and updates to
-- zero-balance rows do not pay for an index write.
CREATE INDEX balances_top ON balances (ledger, balance DESC) WHERE balance > 0;
CREATE INDEX balances_owner ON balances (owner);

-- Only movements at or above idx_state.big_min_raw. kind: transfer | mint | burn.
CREATE TABLE transfers_big (
  ledger        TEXT NOT NULL,
  block         INTEGER NOT NULL,
  ts            INTEGER NOT NULL,
  kind          TEXT NOT NULL,
  from_account  TEXT,
  to_account    TEXT,
  amount        REAL NOT NULL,
  amount_raw    TEXT NOT NULL,
  PRIMARY KEY (ledger, block)
) WITHOUT ROWID;
-- The cross-ledger feed orders by time. Per-ledger feeds use the primary key: block order is time order.
CREATE INDEX transfers_big_ts ON transfers_big (ts DESC);

-- One row per ledger per UTC day that had at least one block. Days without blocks have no row.
CREATE TABLE ledger_daily (
  ledger           TEXT NOT NULL,
  day              INTEGER NOT NULL,         -- unix seconds at 00:00 UTC
  txs              INTEGER NOT NULL DEFAULT 0, -- all blocks: transfers, mints, burns, approves
  transfers        INTEGER NOT NULL DEFAULT 0,
  volume           REAL NOT NULL DEFAULT 0,  -- transferred tokens (mints and burns excluded)
  mints            REAL NOT NULL DEFAULT 0,
  burns            REAL NOT NULL DEFAULT 0,
  fees             REAL NOT NULL DEFAULT 0,  -- fees charged (burned unless the ledger has a fee collector)
  active_accounts  INTEGER NOT NULL DEFAULT 0, -- distinct accounts touched that day (exact)
  new_accounts     INTEGER NOT NULL DEFAULT 0, -- accounts seen for the first time that day
  holders          INTEGER NOT NULL DEFAULT 0, -- accounts with balance > 0 at the end of the day
  PRIMARY KEY (ledger, day)
) WITHOUT ROWID;
