-- A person's market grant does one request, once (ADR 0190): the digest of each one spent, kept
-- until the grant would have expired anyway. A grant captured on the way and sent again is
-- refused, so it can't repeat a withdrawal or a transfer. A new table rewrites nothing.
CREATE TABLE spent_person_grants (
  digest TEXT PRIMARY KEY,
  expires INTEGER NOT NULL
) STRICT;
CREATE INDEX spent_person_grants_expiry ON spent_person_grants (expires);
