-- Token trust score. Written only by src/trust/. Depends on nothing but 0001 (tokens). Timestamps are unix seconds.
-- Methodology: docs/TRUST_SCORE.md and /trust-score. Scoring code: src/trust/score.ts (pure, versioned).

-- One row per token: the latest score with every factor that produced it.
CREATE TABLE trust_scores (
  token_id        TEXT PRIMARY KEY,
  score           INTEGER,                   -- 0 to 100. NULL when insufficient, 0 for a dead ledger.
  grade           TEXT NOT NULL,             -- A | B | C | D | E | DEAD | NA
  insufficient    INTEGER NOT NULL DEFAULT 0,
  factors         TEXT NOT NULL,             -- json array of TrustFactor (key, label, state, points, maxPoints, explanation, evidenceHref, dataAsOf, missing, ...)
  summary         TEXT NOT NULL,             -- json: { tier, rawScore, band, caps, reasons, dead, pointsEarned, pointsMeasured, pointsPossible }
  method_version  TEXT NOT NULL,
  computed_at     INTEGER NOT NULL
);
CREATE INDEX trust_scores_grade ON trust_scores (grade, score DESC);

-- icrc1_minting_account of every ledger, read with an anonymous query. It only changes through a ledger upgrade,
-- so a successful read is kept for days and steady state costs almost nothing.
CREATE TABLE trust_minting (
  token_id    TEXT PRIMARY KEY,
  status      TEXT NOT NULL,                 -- ok | none (ledger reports no minting account) | error (never read successfully)
  owner       TEXT,                          -- principal that owns the minting account
  subaccount  TEXT,                          -- hex, NULL for the default subaccount
  error       TEXT,                          -- last failure, kept next to the last good value
  read_at     INTEGER,                       -- last successful read
  checked_at  INTEGER NOT NULL               -- last attempt
);

-- One hop of "who controls the controller": controllers of canisters that control a ledger or own a minting
-- account but are not watched by Lifeline (so they have no canisters row). Certified read_state, refreshed weekly.
CREATE TABLE trust_controllers (
  canister_id  TEXT PRIMARY KEY,
  controllers  TEXT,                         -- json array, NULL until the first successful read
  error        TEXT,
  read_at      INTEGER,
  checked_at   INTEGER NOT NULL
);

-- Holder inputs per ledger (largest free accounts, excluded accounts with reasons, governance aggregate).
-- Rebuilt every few hours from the block index: concentration moves slowly and the governance aggregate scans
-- every neuron subaccount, so it is not recomputed on every hourly run.
CREATE TABLE trust_holders (
  token_id     TEXT PRIMARY KEY,
  next_block   INTEGER NOT NULL,             -- index height the snapshot was taken at
  as_of        INTEGER,                      -- timestamp of the last applied block at that height
  data         TEXT NOT NULL,                -- json: { supply, holderCount, top: HolderAccount[] }
  computed_at  INTEGER NOT NULL
);
