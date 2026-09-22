-- Smart money: wallets ranked by the outcome of the large DEX trades we saw in our own index.
CREATE TABLE smart_wallets (
  owner         TEXT PRIMARY KEY,
  score         REAL NOT NULL,               -- rank key: pnl weighted by consistency
  realized_usd  REAL NOT NULL,
  unrealized_usd REAL NOT NULL,
  invested_usd  REAL NOT NULL,
  trades        INTEGER NOT NULL,
  wins          INTEGER NOT NULL,
  losses        INTEGER NOT NULL,
  tokens        TEXT NOT NULL,               -- json [{token_id, symbol, bought_usd, sold_usd, held, held_usd, pnl_usd}]
  first_trade   INTEGER,
  last_trade    INTEGER,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX smart_wallets_score ON smart_wallets (score DESC);

-- Net flow of the top wallets per token per day, for "what smart money is buying".
CREATE TABLE smart_flows (
  day           INTEGER NOT NULL,
  token_id      TEXT NOT NULL,
  buy_usd       REAL NOT NULL DEFAULT 0,
  sell_usd      REAL NOT NULL DEFAULT 0,
  wallets       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, token_id)
) WITHOUT ROWID;
