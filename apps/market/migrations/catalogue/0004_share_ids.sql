ALTER TABLE entries ADD COLUMN share_id TEXT;
CREATE UNIQUE INDEX entries_share_id ON entries (share_id) WHERE share_id IS NOT NULL;

UPDATE entries SET share_id =
  printf('%08x-%04x-7', (unixepoch('subsec') * 1000) >> 16, (unixepoch('subsec') * 1000) & 65535)
  || substr(lower(hex(randomblob(2))), 2)
  || '-' || substr('89ab', (random() & 3) + 1, 1)
  || substr(lower(hex(randomblob(2))), 2)
  || '-' || lower(hex(randomblob(6)))
WHERE visibility = 'unlisted' AND audience = 'public' AND type IN ('spade-bot', 'spade-skill');
