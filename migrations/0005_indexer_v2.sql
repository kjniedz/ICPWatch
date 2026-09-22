-- Block indexer v2: reconcile gate, fee collectors, failure classification, ICP ledger.
-- Written only by src/indexer/. See docs/INDEXER.md.

-- What kind of ledger this is and which block reader works for it.
--   kind:   icrc | icp
--   source: blocks (get_blocks, generic blocks with fee_col) | tx (get_transactions, no fee collector data)
--           | icrc3 (icrc3_get_blocks) | icp (query_blocks + archive get_blocks). NULL means not detected yet.
ALTER TABLE idx_state ADD COLUMN kind TEXT NOT NULL DEFAULT 'icrc';
ALTER TABLE idx_state ADD COLUMN source TEXT;
-- Balance rules version the stored balances were replayed with. 1 treated every fee as burned. 2 credits fee
-- collectors. A ledger below the current version that fails to reconcile is wiped and replayed once, automatically.
ALTER TABLE idx_state ADD COLUMN algo_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE idx_state ADD COLUMN replays INTEGER NOT NULL DEFAULT 0;
-- JSON: {"blocks": {"<block index>": "<account>"}, "global": "<account>" | null}. Fee collector declarations seen so far
-- (fee_col blocks that later blocks reference through fee_col_block, and the ICRC-107 ledger-wide collector).
ALTER TABLE idx_state ADD COLUMN fee_cols TEXT;

-- Exact running totals in base units since block 0. Only meaningful for algo_version >= 2 (replayed from 0 with them).
-- Invariant at every commit: minted - burned - fees_burned = sum of balances.
ALTER TABLE idx_state ADD COLUMN minted_raw TEXT NOT NULL DEFAULT '0';
ALTER TABLE idx_state ADD COLUMN burned_raw TEXT NOT NULL DEFAULT '0';
ALTER TABLE idx_state ADD COLUMN fees_burned_raw TEXT NOT NULL DEFAULT '0';
ALTER TABLE idx_state ADD COLUMN fees_collected_raw TEXT NOT NULL DEFAULT '0';

-- Reconcile gate. trusted = complete AND reconcile_ok = 1. Tolerance is zero: the sum of indexed balances must
-- equal icrc1_total_supply exactly at some block height inside the window the supply was read in.
ALTER TABLE idx_state ADD COLUMN reconciled_at INTEGER;
ALTER TABLE idx_state ADD COLUMN reconcile_ok INTEGER;            -- 1 exact, 0 mismatch, NULL never checked
ALTER TABLE idx_state ADD COLUMN reconcile_diff_raw TEXT;         -- ledger supply minus indexed sum at the best matching height
ALTER TABLE idx_state ADD COLUMN reconcile_supply_raw TEXT;       -- icrc1_total_supply as read
ALTER TABLE idx_state ADD COLUMN reconcile_block INTEGER;         -- height (next_block value) the comparison was made at
ALTER TABLE idx_state ADD COLUMN reconcile_note TEXT;
ALTER TABLE idx_state ADD COLUMN reconcile_next_at INTEGER NOT NULL DEFAULT 0;

-- Failure classification. fail_reason is one of:
--   frozen | uninstalled | no_get_transactions | archive_gap | archive_unreachable | decode_error | other
ALTER TABLE idx_state ADD COLUMN fail_reason TEXT;
ALTER TABLE idx_state ADD COLUMN fail_canister TEXT;              -- the canister that failed (the ledger or one of its archives)
ALTER TABLE idx_state ADD COLUMN failed_since INTEGER;            -- start of the current run of failures

-- ICP ledger balances. Accounts are 32 byte account identifiers (hex). The principal behind an identifier is not
-- recoverable from the ledger, so owner stays NULL unless something else (labels) learns it.
-- Every account is kept exactly, dust included. Only accounts holding at least 1 ICP are in the ranking index,
-- so the millions of dust and emptied accounts cost one row write per update instead of three.
CREATE TABLE icp_balances (
  account      TEXT PRIMARY KEY,             -- account identifier, 64 hex chars, lowercase
  owner        TEXT,                         -- always NULL from the indexer
  balance      REAL NOT NULL,                -- whole ICP, approximate, for ordering only
  balance_raw  TEXT NOT NULL,                -- exact e8s
  tx_count     INTEGER NOT NULL DEFAULT 0,
  first_seen   INTEGER NOT NULL,
  last_active  INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX icp_balances_top ON icp_balances (balance DESC) WHERE balance >= 1;

-- Counterparty lookups for labels and account pages (accountFlows).
CREATE INDEX transfers_big_from ON transfers_big (ledger, from_account, ts);
CREATE INDEX transfers_big_to ON transfers_big (ledger, to_account, ts);
