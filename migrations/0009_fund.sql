-- Community top-ups ("Fund this canister"). Depends only on 0001 (canisters).
-- ICPWatch never holds funds: supporters send ICP straight to the canister's deposit account at the
-- cycles minting canister (CMC), and anyone (here: the Worker) may then call notify_top_up for that block.
-- These tables only record what happened on chain, so the public record can be rebuilt from the ledger.
--
--   fund_intents   someone opened the panel and said "I am about to pay" (or is paying with a wallet).
--                  An intent is what makes the watcher look at a deposit account. Expires after 24 h.
--   fund_watch     one row per watched canister: deposit account, cursor, and a check lease so that
--                  overlapping cron ticks and page polls never scan the same account at the same time.
--   fund_deposits  one row per ICP ledger block that paid into a deposit account. block_index is the
--                  PRIMARY KEY, so a block can never be recorded (or claimed for notify) twice.

CREATE TABLE fund_intents (
  id            TEXT PRIMARY KEY,                       -- random token, known only to the browser that created it
  canister_id   TEXT NOT NULL,
  mode          TEXT NOT NULL CHECK (mode IN ('keep_alive', 'revive')),
  method        TEXT NOT NULL DEFAULT 'deposit' CHECK (method IN ('deposit', 'wallet', 'cycles')),
  planned_cycles INTEGER,
  planned_e8s   INTEGER,
  from_account  TEXT,                                   -- optional: sending ICP account identifier (64 hex), declared BEFORE paying
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);
CREATE INDEX fund_intents_canister ON fund_intents (canister_id, expires_at);
CREATE INDEX fund_intents_expiry ON fund_intents (expires_at);

CREATE TABLE fund_watch (
  canister_id     TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL,                        -- CMC deposit account identifier for this canister (64 hex)
  watch_until     INTEGER NOT NULL,                     -- latest intent expiry
  last_checked_at INTEGER NOT NULL DEFAULT 0,
  check_lease     INTEGER NOT NULL DEFAULT 0,           -- unix seconds until which one checker owns this row
  last_block      INTEGER,                              -- highest ledger block seen for this account
  last_error      TEXT
);
CREATE INDEX fund_watch_due ON fund_watch (watch_until, last_checked_at);

CREATE TABLE fund_deposits (
  block_index   INTEGER PRIMARY KEY,                    -- ICP ledger block of the transfer: the idempotency key
  canister_id   TEXT NOT NULL,
  from_account  TEXT NOT NULL,                          -- sending account identifier, from the ledger block
  e8s           INTEGER NOT NULL CHECK (e8s >= 0),
  memo_ok       INTEGER NOT NULL CHECK (memo_ok IN (0, 1)),   -- 1 = memo is TPUP (0x50555054), legacy or icrc1
  block_ts      INTEGER,
  seen_at       INTEGER NOT NULL,
  source        TEXT NOT NULL DEFAULT 'watcher',        -- watcher | client | admin
  -- pending -> converting -> credited | refunded | failed | too_old ; wrong_memo is parked (see docs)
  status        TEXT NOT NULL CHECK (status IN ('pending', 'converting', 'credited', 'refunded', 'failed', 'too_old', 'wrong_memo')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  claimed_at    INTEGER,                                -- notify lease: a second tick may only re-claim after it lapses
  cycles        INTEGER,                                -- cycles the CMC reported as minted
  credited_at   INTEGER,
  refund_block  INTEGER,
  error         TEXT,
  -- context captured when the deposit was recorded, so the public record can say what it bought
  intent_id     TEXT,
  mode          TEXT,                                   -- keep_alive | revive | null (unknown: nobody declared an intent)
  idle_burn_per_day INTEGER,                            -- idle burn at the time, to express the top-up as preservation time
  -- supporter attribution: optional, plain text, only shown once status = 'credited' and hidden = 0
  display_name  TEXT,
  display_link  TEXT,
  display_set_at INTEGER,
  hidden        INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
  hidden_reason TEXT
);
CREATE INDEX fund_deposits_canister ON fund_deposits (canister_id, block_index DESC);
CREATE INDEX fund_deposits_status ON fund_deposits (status, seen_at);
CREATE INDEX fund_deposits_credited ON fund_deposits (credited_at DESC);

-- The on-chain facts of a deposit never change once written. Only the processing and display columns may.
CREATE TRIGGER fund_deposits_facts_frozen BEFORE UPDATE OF block_index, canister_id, from_account, e8s, memo_ok ON fund_deposits
WHEN NEW.block_index <> OLD.block_index OR NEW.canister_id <> OLD.canister_id OR NEW.from_account <> OLD.from_account OR NEW.e8s <> OLD.e8s OR NEW.memo_ok <> OLD.memo_ok
BEGIN SELECT RAISE(ABORT, 'fund_deposits: on-chain facts are immutable'); END;

-- A credited deposit stays credited, with the cycles it was credited with.
CREATE TRIGGER fund_deposits_credited_final BEFORE UPDATE OF status, cycles ON fund_deposits
WHEN OLD.status = 'credited' AND (NEW.status <> 'credited' OR NEW.cycles IS NOT OLD.cycles)
BEGIN SELECT RAISE(ABORT, 'fund_deposits: a credited deposit is final'); END;

CREATE TRIGGER fund_deposits_no_delete BEFORE DELETE ON fund_deposits
BEGIN SELECT RAISE(ABORT, 'fund_deposits is a public record: hide a row, never delete it'); END;
