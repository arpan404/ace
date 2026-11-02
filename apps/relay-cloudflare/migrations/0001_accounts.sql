-- ace accounts and machine directory (ADR 0111). No column holds a usable token: ids, secrets
-- and session tokens are SHA-256 digests; WorkOS refresh tokens, PKCE verifiers and sessions
-- awaiting their claim are AES-256-GCM sealed to the row's digest.

CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  account TEXT NOT NULL,
  refresh TEXT NOT NULL,
  expires INTEGER NOT NULL,
  -- While a WorkOS refresh is running, other readers use the stored account instead of
  -- spending the same single-use refresh token.
  refreshing_until INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX sessions_expiry ON sessions (expires);

CREATE TABLE logins (
  id TEXT PRIMARY KEY,
  secret TEXT NOT NULL,
  expires INTEGER NOT NULL,
  -- new -> browser -> exchanging -> complete | failed
  phase TEXT NOT NULL,
  state TEXT UNIQUE,
  binding TEXT,
  verifier TEXT,
  session TEXT,
  issued TEXT,
  claimed INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX logins_expiry ON logins (expires);

CREATE TABLE machines (
  host_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
) STRICT;
CREATE INDEX machines_account ON machines (account_id, last_seen_at);
