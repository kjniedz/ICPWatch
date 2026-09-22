-- Token links and descriptions with provenance. A link is published only when an on-chain source states
-- it or two independent sources agree; anything weaker waits in the review queue.

CREATE TABLE token_links (
  token_id    TEXT NOT NULL,
  kind        TEXT NOT NULL,                 -- website | twitter | telegram | discord | github | docs | whitepaper | forum | other
  url         TEXT NOT NULL,                 -- normalized: https, no trailing slash, host lowercased
  sources     TEXT NOT NULL,                 -- json array of source ids: icrc1_metadata | sns_metadata | seed | coingecko | submission:<id> | icpwatch
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('published', 'pending', 'rejected')),
  note        TEXT,                          -- reviewer note
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (token_id, kind, url)
) WITHOUT ROWID;
CREATE INDEX token_links_status ON token_links (status, updated_at DESC);

CREATE TABLE token_descriptions (
  token_id    TEXT PRIMARY KEY,
  text        TEXT NOT NULL,
  source      TEXT NOT NULL,                 -- icpwatch (original) | facts (generated from on-chain facts)
  updated_at  INTEGER NOT NULL
);

-- Per-token cursor for the third-party link source, so CoinGecko's free tier is never hammered.
CREATE TABLE token_meta_state (
  token_id    TEXT PRIMARY KEY,
  onchain_at  INTEGER,                       -- last icrc1_metadata read
  gecko_at    INTEGER,                       -- last CoinGecko lookup (success or a definitive 404)
  gecko_id    TEXT,                          -- CoinGecko coin id when listed, '-' when known unlisted
  updated_at  INTEGER NOT NULL
);
