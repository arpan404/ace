-- Machine credentials (ADR 0190). A daemon keeps a credential bound to its host id instead of the
-- person's ace session, so nothing on a machine's disk can mint a grant that carries the person's
-- standing.
--
-- `standing` says whether a session may still speak for the person: `person` for an app's
-- sign-in from this version on, which only that app holds; `legacy` for sessions from before it,
-- which may have been written to a machine's disk; `exposed` for a session a machine keeps (a
-- daemon's `ace login`, one a daemon asked for a machine grant with, or one exchanged from a
-- session file). Only `person` sessions mint person grants. `retired`: the session's token opens
-- nothing; only the machine credential exchanged from it still renews it. Adding columns with a
-- constant default rewrites nothing.
ALTER TABLE sessions ADD COLUMN standing TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE sessions ADD COLUMN retired INTEGER NOT NULL DEFAULT 0;

-- Who a pending sign-in is for (ADR 0190): `person` (an app) or `machine` (a daemon). Sign-ins
-- from before it are read by their return address, as older apps and daemons send them.
ALTER TABLE logins ADD COLUMN holder TEXT;

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

-- Single-use tickets an app gets with the person's session for one host id, and hands its daemon
-- instead of the session. `ticket` is a digest. Redeeming one consumes it.
CREATE TABLE machine_enrollments (
  ticket TEXT PRIMARY KEY,
  session TEXT NOT NULL,
  host_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  expires INTEGER NOT NULL
) STRICT;
CREATE INDEX machine_enrollments_expiry ON machine_enrollments (expires);
