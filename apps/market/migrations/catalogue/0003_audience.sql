-- Who may read an entry (ADR 0206 §5.1): `public`, or `org:<id>` for an organization's private
-- registry, whose entries answer only to that organization's members. A constant default, so
-- adding it rewrites nothing (ADR 0174 §16). A registry entry is also never `listed`: it is
-- stored unlisted, so the index, search, Discover and every list leave it out.
ALTER TABLE entries ADD COLUMN audience TEXT NOT NULL DEFAULT 'public';
