-- ck reserves dashboard. Amounts are base units as TEXT (wei does not fit an int64), ratios as REAL.

CREATE TABLE reserves_latest (
  asset            TEXT PRIMARY KEY,           -- adapter id: ckBTC, ckETH, ckUSDC, ...
  symbol           TEXT NOT NULL,
  chain            TEXT NOT NULL,
  ledger_id        TEXT NOT NULL,
  minter_id        TEXT NOT NULL,
  ts               INTEGER NOT NULL,
  status           TEXT NOT NULL,              -- backed | within_tolerance | deviation | unknown
  raw_ratio        REAL,
  reconciled_ratio REAL,
  supply_raw       TEXT,
  reserves_raw     TEXT,                       -- minter's own accounting
  native_raw       TEXT,                       -- native chain consensus, when readable
  pending_in_raw   TEXT,
  pending_out_raw  TEXT,
  verified         INTEGER NOT NULL DEFAULT 0, -- native chain (third party) confirmed the minter figure
  data             TEXT NOT NULL               -- json: full ReserveSnapshot (reconciliation, provenance, addresses, extra)
);

CREATE TABLE reserves_series (
  asset            TEXT NOT NULL,
  ts               INTEGER NOT NULL,
  supply_raw       TEXT,
  reserves_raw     TEXT,
  native_raw       TEXT,
  pending_in_raw   TEXT,
  pending_out_raw  TEXT,
  raw_ratio        REAL,
  reconciled_ratio REAL,
  status           TEXT NOT NULL,
  PRIMARY KEY (asset, ts)
) WITHOUT ROWID;
