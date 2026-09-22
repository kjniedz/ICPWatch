-- Telegram bot: one row per chat the bot has talked to, and the feeds a chat has switched on.

CREATE TABLE telegram_chats (
  chat_id       TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,               -- private | group | supergroup | channel
  title         TEXT,
  tz_offset_h   REAL NOT NULL DEFAULT 0,     -- hours from UTC, for quiet hours
  quiet_from_h  INTEGER,                     -- local hour 0..23, NULL = no quiet hours
  quiet_to_h    INTEGER,
  hour_start    INTEGER NOT NULL DEFAULT 0,  -- start of the current rate-limit window
  sent_in_hour  INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);

CREATE TABLE telegram_feeds (
  chat_id       TEXT NOT NULL REFERENCES telegram_chats (chat_id) ON DELETE CASCADE,
  feed          TEXT NOT NULL CHECK (feed IN ('sns', 'whales', 'launches', 'lifeline', 'moves')),
  enabled       INTEGER NOT NULL DEFAULT 1,
  cursor        INTEGER NOT NULL DEFAULT 0,  -- unix ts of the newest item already posted
  held          TEXT,                        -- json array of items held during quiet hours
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (chat_id, feed)
) WITHOUT ROWID;
