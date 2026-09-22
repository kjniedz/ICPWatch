-- Claimed project profiles. Verification proves control of the ledger, the DAO, or the on-chain website;
-- it never feeds the trust score.

CREATE TABLE project_claims (
  id            TEXT PRIMARY KEY,            -- public claim id
  token_id      TEXT NOT NULL,
  method        TEXT NOT NULL CHECK (method IN ('controller_payment', 'dao_motion', 'domain')),
  code          TEXT NOT NULL,               -- challenge: e8s amount for payments, text token for motion/domain
  subject       TEXT,                        -- controller principal, or domain
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'rejected', 'expired')),
  evidence      TEXT,                        -- json: block index, proposal id, or fetched url
  contact       TEXT,
  edit_key_hash TEXT,                        -- sha256 of the edit key handed out on verification
  created_at    INTEGER NOT NULL,
  verified_at   INTEGER,
  checked_at    INTEGER
);
CREATE INDEX project_claims_token ON project_claims (token_id, status);
CREATE INDEX project_claims_pending ON project_claims (status, created_at);

CREATE TABLE project_profiles (
  token_id      TEXT PRIMARY KEY,
  claim_id      TEXT NOT NULL REFERENCES project_claims (id),
  display_name  TEXT,
  tagline       TEXT,                        -- one line, the project's own words, shown as such
  links         TEXT NOT NULL DEFAULT '[]',  -- json [{kind, url}]
  contact       TEXT,
  updated_at    INTEGER NOT NULL
);
