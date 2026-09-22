-- Entity labels: who is behind a principal, an ICRC-1 account, or an ICP account identifier.
-- Written only by src/labels/. Timestamps are unix seconds.
--
-- id is one of:
--   principal text                      "2jvtu-yqaaa-aaaaq-aaama-cai"
--   ICRC-1 account text with subaccount "2jvtu-yqaaa-aaaaq-aaama-cai-t6mekta.d1216f..."
--   ICP account identifier, 64 hex      "a2200978cf15fa0d19b7c7eb75cc5d6d3ebabbacaec64a2a9a3f811277619c57"
--   "neuron:<id>"                       NNS known neurons (their controlling principals are not public)
--
-- confidence: verified  = derived from on-chain facts we can re-check (source says which call)
--             inferred  = third-party attribution or a flow heuristic, always rendered differently
--             community = submitted by a user and approved by a reviewer
-- A weaker confidence never replaces a stronger one: verified > community > inferred (enforced in src/labels/store.ts).
CREATE TABLE labels (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  category    TEXT NOT NULL,               -- LabelCategory in src/labels/index.ts
  confidence  TEXT NOT NULL CHECK (confidence IN ('verified', 'inferred', 'community')),
  source      TEXT NOT NULL,               -- human readable evidence, e.g. "SNS root list_sns_canisters"
  token_id    TEXT,                        -- ledger canister id of the related token, when there is one
  url         TEXT,
  owner       TEXT,                        -- principal this id was derived from (account identifiers and subaccounts), else NULL
  origin      TEXT NOT NULL CHECK (origin IN ('seed', 'derived', 'flow', 'community')),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX labels_category ON labels (category, name COLLATE NOCASE);
CREATE INDEX labels_name ON labels (name COLLATE NOCASE);
CREATE INDEX labels_token ON labels (token_id);
CREATE INDEX labels_owner ON labels (owner);

-- Review queue. Nothing in here is ever rendered publicly: a row becomes visible only when a reviewer
-- approves it, which writes a 'community' label. Flow heuristics also file their candidates here
-- (origin 'flow') instead of publishing them.
CREATE TABLE label_submissions (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  target_id          TEXT NOT NULL,        -- normalized the same way as labels.id
  name               TEXT NOT NULL,
  category           TEXT NOT NULL,
  evidence_url       TEXT,
  note               TEXT,                 -- submitter's note, or the heuristic's evidence as json
  submitter_contact  TEXT,
  origin             TEXT NOT NULL DEFAULT 'public' CHECK (origin IN ('public', 'flow')),
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at         INTEGER NOT NULL,
  reviewed_at        INTEGER,
  reviewer_note      TEXT
);
CREATE INDEX label_submissions_status ON label_submissions (status, created_at DESC);
CREATE INDEX label_submissions_target ON label_submissions (target_id);
-- One heuristic candidate per target, ever: a rejected candidate is not filed again on the next run.
CREATE UNIQUE INDEX label_submissions_flow ON label_submissions (target_id) WHERE origin = 'flow';
