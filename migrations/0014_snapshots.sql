-- Holder snapshots: a frozen, hashed copy of a ledger's balances at one block, kept forever behind a
-- permanent link. The rows travel as gzip-compressed CSV chunks so a 30k-holder ledger fits in one row.

CREATE TABLE snapshots (
  id            TEXT PRIMARY KEY,            -- short random id in the URL
  ledger        TEXT NOT NULL,
  symbol        TEXT NOT NULL,
  decimals      INTEGER NOT NULL,
  block         INTEGER NOT NULL,            -- last block applied when the snapshot was taken
  block_ts      INTEGER,                     -- that block's timestamp
  supply_raw    TEXT,                        -- icrc1_total_supply the index reconciled against
  taken_at      INTEGER NOT NULL,
  look_through  INTEGER NOT NULL DEFAULT 0,  -- SNS neuron stakes attributed to controllers
  filters       TEXT NOT NULL,               -- json: {min_balance, exclude: [categories], top}
  rows          INTEGER NOT NULL,            -- rows in the file
  holders_total INTEGER NOT NULL,            -- holders on the ledger before filters
  sum_raw       TEXT NOT NULL,               -- sum of balance_raw over the rows
  hash          TEXT NOT NULL,               -- sha256 of the canonical CSV, hex
  size_bytes    INTEGER NOT NULL,            -- canonical CSV size
  creator_note  TEXT
);
CREATE INDEX snapshots_ledger ON snapshots (ledger, taken_at DESC);

CREATE TABLE snapshot_blobs (
  snapshot_id   TEXT NOT NULL REFERENCES snapshots (id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  data          BLOB NOT NULL,               -- gzip of a slice of the canonical CSV
  PRIMARY KEY (snapshot_id, seq)
) WITHOUT ROWID;
