-- Canister change history from the management canister's canister_info (anonymous query).
-- The IC keeps only the last 20 changes per canister, so the hourly history collector accumulates them here.
CREATE TABLE canister_history (
  canister_id       TEXT NOT NULL,
  canister_version  INTEGER NOT NULL,
  ts                INTEGER NOT NULL,          -- unix seconds
  kind              TEXT NOT NULL,             -- creation | install | reinstall | upgrade | uninstall | controllers_change | snapshot | other
  module_hash       TEXT,                      -- hex, for install | reinstall | upgrade
  controllers       TEXT,                      -- json array, for creation | controllers_change
  origin            TEXT,                      -- user:<principal> | canister:<canister id>
  PRIMARY KEY (canister_id, canister_version)
) WITHOUT ROWID;
CREATE INDEX canister_history_ts ON canister_history (ts DESC);

-- One row per canister: what canister_info said last time. Baseline for controller and module change alerts.
CREATE TABLE canister_history_state (
  canister_id    TEXT PRIMARY KEY,
  total_changes  INTEGER NOT NULL,             -- total_num_changes reported by the IC (more than we can ever list)
  module_hash    TEXT,
  controllers    TEXT,                         -- json array
  checked_at     INTEGER NOT NULL,
  error          TEXT                          -- last failure, NULL when the last check worked
) WITHOUT ROWID;
