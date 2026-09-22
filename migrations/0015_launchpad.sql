-- Launchpad tokens (FomoWell today), pool TVL history for liquidity alerts.

CREATE TABLE launchpad_tokens (
  source        TEXT NOT NULL,               -- fomowell
  ext_id        TEXT NOT NULL,               -- launchpad's own id
  ticker        TEXT NOT NULL,
  name          TEXT NOT NULL,
  creator       TEXT,
  kind          TEXT,                        -- rune | brc20 | icrc | ...
  ledger        TEXT,                        -- ICRC ledger id when the token has one
  created_at    INTEGER,
  progress      REAL,                        -- bonding curve 0..1
  graduated     INTEGER NOT NULL DEFAULT 0,
  frozen        INTEGER NOT NULL DEFAULT 0,
  price_sats    REAL,
  pool_sats     REAL,                        -- quote reserve in sats
  mcap_sats     REAL,
  creator_share REAL,                        -- 0..1 of circulating, latest pass
  creator_share_first REAL,                  -- at first sight
  top5_share    REAL,
  lp_locked     INTEGER,                     -- 1 locked, 0 not, NULL unknown
  flags         TEXT NOT NULL DEFAULT '[]',  -- json: bundled | creator_sold | frozen | thin
  score         INTEGER,                     -- provisional 0..100
  grade         TEXT,                        -- provisional letter
  links         TEXT,                        -- json {website, twitter, telegram}
  logo          TEXT,
  first_seen    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (source, ext_id)
) WITHOUT ROWID;
CREATE INDEX launchpad_created ON launchpad_tokens (created_at DESC);

-- Hourly pool TVL points, kept 7 days, for liquidity-drop detection.
CREATE TABLE pool_tvl (
  pool_id       TEXT NOT NULL,
  ts            INTEGER NOT NULL,
  tvl_usd       REAL NOT NULL,
  PRIMARY KEY (pool_id, ts)
) WITHOUT ROWID;
