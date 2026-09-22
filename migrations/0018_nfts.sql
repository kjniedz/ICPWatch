-- NFT collections: registry from Entrepot (third party), stats from each canister's own stats() query.
CREATE TABLE nft_collections (
  id            TEXT PRIMARY KEY,            -- collection canister
  name          TEXT NOT NULL,
  standard      TEXT,
  registry      TEXT NOT NULL,               -- entrepot
  links         TEXT,                        -- json {web, twitter, discord, telegram}
  avatar        TEXT,
  volume_icp    REAL,                        -- all-time, from stats()
  high_icp      REAL, low_icp REAL, floor_icp REAL,
  listings      INTEGER, supply INTEGER, trades INTEGER,
  stats_at      INTEGER,
  stats_error   TEXT,
  first_seen    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX nft_volume ON nft_collections (volume_icp DESC);
