-- Consistency for organizations (ADR 0206), after review of WP1. New columns with constant
-- defaults and new tables only: nothing existing is rewritten (ADR 0170).

-- A machine credential belongs to one org host enrollment, never to whichever organization its
-- host is in now. `org_hosts.enrollment` names each enrollment; a credential bound to an earlier
-- one, or to none, speaks for no organization, and releasing a host revokes its credentials.
ALTER TABLE org_hosts ADD COLUMN enrollment TEXT;
ALTER TABLE machine_credentials ADD COLUMN enrollment TEXT;

-- Who holds a session's refresh lease: only that holder may rotate, release or end the session
-- on what its refresh found.
ALTER TABLE sessions ADD COLUMN refresh_lease TEXT;

-- `seq` counts every change the mirror applies to a membership. An org check records the `seq`
-- it began under and counts only while that is current, so an answer WorkOS gave before a
-- demotion or removal never lands after it.
ALTER TABLE org_members ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE org_checks ADD COLUMN member_seq INTEGER;

-- The WorkOS time of the profile (email, name) a member row shows: an older one never replaces it.
ALTER TABLE org_members ADD COLUMN profile_version TEXT NOT NULL DEFAULT '';

-- Short leases that serialize work across isolates: an organization's membership changes
-- (`members:<org>`) and an admin's Admin Portal links against their revocation
-- (`portal:<org>:<account>`). `holder` is the request that took it.
CREATE TABLE org_locks (
  name TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  until INTEGER NOT NULL
) STRICT;

-- Admin Portal sessions still to revoke, one row per organization and account (ADR 0206 §6),
-- queued on every removal, deactivation or demotion and retried until WorkOS confirms. `queued`
-- counts queuings, so a revocation finished for an older one doesn't drop a newer one.
CREATE TABLE org_portal_revocations (
  org_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  queued INTEGER NOT NULL DEFAULT 1,
  tries INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, account_id)
) STRICT;
CREATE INDEX org_portal_revocations_due ON org_portal_revocations (next_at);

-- A D1 batch can't branch, but it does roll back when any statement fails: an events page's
-- batch starts by inserting `ok = 0` here when the cursor is no longer where its run read it,
-- which fails, so the page applies nothing and the cursor never moves back.
CREATE TABLE workos_event_guard (ok INTEGER NOT NULL CHECK (ok = 1)) STRICT;
