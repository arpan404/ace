-- Machines' consents to become an organization's host (ADR 0206 §2.1). A daemon gives one only to
-- a socket that proved its owner's standing (ADR 0190), for one host and organization; enrolling
-- spends it here, so it enrolls once. Rows are kept until they lapse, then swept. A new table:
-- nothing existing is rewritten (ADR 0170).
CREATE TABLE org_enroll_consents (
  nonce TEXT PRIMARY KEY,
  host_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX org_enroll_consents_expiry ON org_enroll_consents (expires_at);
