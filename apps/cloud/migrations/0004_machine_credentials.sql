-- Machine credentials (ADR 0190). A daemon keeps a credential bound to its host id instead of the
-- person's ace session, so nothing on a machine's disk can mint a grant that carries the person's
-- standing.
--
-- `standing` says whether a session may still speak for the person: `person` for sign-ins from
-- this version on, which only the client that signed in holds; `legacy` for sessions from before
-- it, which may have been written to a machine's disk; `exposed` for a session that was (a daemon
-- asked for a machine grant with it, or exchanged it from its session file). Only `person`
-- sessions mint person-standing grants. Adding a column with a constant default rewrites nothing.
ALTER TABLE sessions ADD COLUMN standing TEXT NOT NULL DEFAULT 'legacy';

-- `token` is the credential's digest, `session` the digest of the session it was exchanged from,
-- which it lives and is renewed with: WorkOS refreshes stay on that one session. `sole`: the
-- daemon was that session's only holder, so the session's token was retired at the exchange and
-- the machine signing out ends the session too.
CREATE TABLE machine_credentials (
  token TEXT PRIMARY KEY,
  session TEXT NOT NULL,
  host_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  expires INTEGER NOT NULL,
  sole INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX machine_credentials_expiry ON machine_credentials (expires);
