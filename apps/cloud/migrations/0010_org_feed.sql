-- The members mirror's feed decided against what is committed (ADR 0206 §6, amendment 1). New
-- tables only, empty at open: nothing existing is rewritten (ADR 0170).

-- A user WorkOS deleted, at the WorkOS time of the deletion: no membership event at or before
-- it is applied again, whatever order the feed and the webhook bring them in.
CREATE TABLE org_deleted_users (
  account_id TEXT PRIMARY KEY,
  version TEXT NOT NULL
) STRICT;

-- A membership WorkOS deleted: none of its events brings it back, however late they arrive.
CREATE TABLE org_deleted_memberships (
  membership_id TEXT PRIMARY KEY,
  version TEXT NOT NULL
) STRICT;

-- Audit entries the feed owes the organization's WorkOS copy, written in the same batch as the
-- change they record and sent, with the same idempotency key, until WorkOS takes them.
CREATE TABLE org_audit_outbox (
  key TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  event TEXT NOT NULL,
  tries INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL
) STRICT;
CREATE INDEX org_audit_outbox_due ON org_audit_outbox (next_at);
