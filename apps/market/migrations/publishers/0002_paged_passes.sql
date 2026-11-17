-- ADR 0173 §16: fencing for listing pictures, and the quota reconcile in bounded pages.

-- Moves each time a picture's reservation is written or renewed (an upload, or a listing edit
-- that names it). The sweep drops a row only while its generation is the one it read.
ALTER TABLE pictures ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;

-- The reconcile pass that last found this charge's version (its `started`).
ALTER TABLE charges ADD COLUMN seen INTEGER;

-- A publisher's reconcile pass in progress: the catalogue (by its place in the router's order)
-- and the last version item read there. Charges the pass never found are dropped only when it
-- has read every catalogue.
CREATE TABLE usage_passes (
  publisher TEXT PRIMARY KEY,
  started INTEGER NOT NULL,
  catalogue INTEGER NOT NULL DEFAULT 0,
  after TEXT NOT NULL DEFAULT ''
);
