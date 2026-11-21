-- Organizations on WorkOS (ADR 0206). WorkOS is the authority for organizations and their
-- memberships; these tables are a mirror for listing and fast refusals, filled from WorkOS's
-- Events API by the cron and by the backend's own writes. Every org-scoped grant is decided on a
-- fresh WorkOS answer kept in `org_checks`, at most 60 seconds old. Everything here is new
-- tables or columns with a constant default: nothing existing is rewritten (ADR 0170).
--
-- `version` columns hold the WorkOS `updated_at` (ISO 8601, which sorts as text) of the state a
-- row reflects: an older event replayed after a newer write changes nothing.

-- `org_id` is the WorkOS organization id. `plan`: `pilot` or `team` (ADR 0206 §7). `no_owner`:
-- the directory left it without an active owner; only ace support names one.
CREATE TABLE orgs (
  org_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'pilot',
  created_by TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  no_owner INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  version TEXT NOT NULL DEFAULT ''
) STRICT;

-- One row per person and organization. `status`: WorkOS's `pending`, `active` or `inactive`, or
-- `removed` once the membership is deleted, kept for history. `role` is the WorkOS role slug as
-- WorkOS gave it, unknown ones included; ace maps it to permissions itself.
CREATE TABLE org_members (
  org_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  directory_managed INTEGER NOT NULL DEFAULT 0,
  email TEXT,
  name TEXT,
  version TEXT NOT NULL DEFAULT '',
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, account_id)
) STRICT;
CREATE INDEX org_members_account ON org_members (account_id, status);
CREATE INDEX org_members_membership ON org_members (membership_id);

-- WorkOS's answer to "may this session enter this organization", from a refresh with
-- `organization_id` whose access token verified against WorkOS's JWKS. `session` is the ace
-- session's digest. Reused for 60 seconds, then asked again.
CREATE TABLE org_checks (
  session TEXT NOT NULL,
  org_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  role TEXT NOT NULL,
  sid TEXT NOT NULL,
  checked_at INTEGER NOT NULL,
  PRIMARY KEY (session, org_id)
) STRICT;
CREATE INDEX org_checks_age ON org_checks (checked_at);

-- Machines an organization owns (ADR 0206 §2.1). `audit_key`: the host's Ed25519 audit key
-- (base64url), registered at enrollment, that signs its log's checkpoints.
CREATE TABLE org_hosts (
  host_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  enrolled_by TEXT NOT NULL,
  enrolled_at INTEGER NOT NULL,
  audit_key TEXT
) STRICT;
CREATE INDEX org_hosts_org ON org_hosts (org_id);

-- Each version of an organization's policy (ADR 0206 §3), as stored and hashed, with the
-- statement the grant key signed over it.
CREATE TABLE org_policies (
  org_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  body TEXT NOT NULL,
  body_sha256 TEXT NOT NULL,
  set_by TEXT NOT NULL,
  set_at INTEGER NOT NULL,
  statement TEXT NOT NULL,
  PRIMARY KEY (org_id, version)
) STRICT;

-- Where the events cron is in WorkOS's Events API: the id of the last event it applied.
CREATE TABLE workos_events (
  feed TEXT PRIMARY KEY,
  after TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

-- An org host's directory row and machine credentials name the organization that owns it.
ALTER TABLE machines ADD COLUMN org_id TEXT;
ALTER TABLE machine_credentials ADD COLUMN org_id TEXT;
