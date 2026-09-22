-- Price and volume alert rules. The channel, address, and verification live in the subscriptions row
-- (scope_type 'price', scope_id = token id); each rule here belongs to one of those rows.

CREATE TABLE price_rules (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id TEXT NOT NULL REFERENCES subscriptions (id) ON DELETE CASCADE,
  token_id        TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('above', 'below', 'move_pct', 'volume_x')),
  value           REAL NOT NULL,             -- USD price for above/below, percent for move_pct, multiple for volume_x
  window_s        INTEGER,                   -- move_pct only: 3600 or 86400
  cooldown_s      INTEGER NOT NULL DEFAULT 21600,
  armed           INTEGER NOT NULL DEFAULT 1, -- move_pct re-arms once price is back inside the band; above/below re-arm once crossed back
  last_fired_at   INTEGER,
  fired_count     INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);
CREATE INDEX price_rules_token ON price_rules (token_id);
CREATE INDEX price_rules_sub ON price_rules (subscription_id);

-- Public "what just moved" feed: one row per fired rule kind per token, no addresses.
CREATE TABLE price_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id    TEXT NOT NULL,
  kind        TEXT NOT NULL,
  detail      TEXT NOT NULL,
  price_usd   REAL,
  ts          INTEGER NOT NULL
);
CREATE INDEX price_events_ts ON price_events (ts DESC);
