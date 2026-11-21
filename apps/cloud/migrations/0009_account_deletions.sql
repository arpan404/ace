-- Account deletions (App Store guideline 5.1.1(v)). A row is both the record of a deletion
-- that may still need finishing and the tombstone that stops anything recreating the account's
-- rows while it, or a sign-in or relay grant issued before it, is still in flight.
--
-- `session`: the digest of the session that asked, which may retry until `finished_at` is set
-- (empty once finished). The sweep finishes a deletion nobody retried, and forgets a finished
-- one after 30 days, when grants and sign-ins from before it have long expired.
CREATE TABLE account_deletions (
  account_id TEXT PRIMARY KEY,
  session TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
) STRICT;
CREATE INDEX account_deletions_session ON account_deletions (session);
