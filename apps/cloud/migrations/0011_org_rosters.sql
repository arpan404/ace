-- Each organization's member roster as its hosts are served it (ADR 0209 §7.2): the version a
-- host was last given and the SHA-256 of that body. A body that differs from the last one served
-- takes the next version, so versions only grow and a host refuses any lower one. A new table,
-- empty at open: nothing existing is rewritten (ADR 0170).
CREATE TABLE org_rosters (
  org_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  body_sha256 TEXT NOT NULL
) STRICT;
