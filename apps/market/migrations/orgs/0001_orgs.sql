-- Organizations' private registries (ADR 0206 §5.1), one shared-domain database: each
-- registry's publisher, the members an owner named as its publishers, and its key chain. The
-- entries themselves live in their type's catalogue, marked with the organization's audience.

-- One registry per organization. `publisher` is its publisher row in the publishers database,
-- whose `account` column holds the organization's id (WorkOS user ids never start `org_`).
CREATE TABLE registries (
  org TEXT PRIMARY KEY,
  publisher TEXT NOT NULL UNIQUE,
  created INTEGER NOT NULL,
  created_by TEXT NOT NULL
) STRICT;

-- Members an owner named as registry publishers beyond the roles that may (§5.1).
CREATE TABLE registry_publishers (
  org TEXT NOT NULL REFERENCES registries (org),
  account TEXT NOT NULL,
  added INTEGER NOT NULL,
  added_by TEXT NOT NULL,
  PRIMARY KEY (org, account)
) STRICT;

-- The registry's signing keys, first first (§5.3). `upload` is the owner's request body exactly
-- as sent, and `grant` the owner's market grant that named its digest: the account backend's
-- countersignature, which devices check again. A new first key replaces the whole chain (a
-- reset, which every device asks about again).
CREATE TABLE registry_keys (
  org TEXT NOT NULL REFERENCES registries (org),
  position INTEGER NOT NULL,
  key_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  upload TEXT NOT NULL,
  grant_token TEXT NOT NULL,
  added_by TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (org, position)
) STRICT;
