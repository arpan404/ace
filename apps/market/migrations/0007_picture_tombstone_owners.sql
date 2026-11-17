-- ADR 0173 §1: one sweep at a time acts on a picture claim. `owner` is the id of the cron run
-- that holds the claim, `generation` goes up each time a run takes or renews it, and
-- `leased_at` is when it did. A run takes a claim only while it is unowned, its own, or its
-- lease has lapsed, and deletes the object only after re-checking that it still holds that
-- owner and generation, so a slow run that lost the claim deletes nothing. Existing claims
-- become unowned (owner NULL, generation 0, a lease long lapsed), so the next run can take them.
ALTER TABLE picture_tombstones ADD COLUMN owner TEXT;
ALTER TABLE picture_tombstones ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE picture_tombstones ADD COLUMN leased_at INTEGER NOT NULL DEFAULT 0;
