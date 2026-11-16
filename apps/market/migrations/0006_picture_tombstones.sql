-- ADR 0173 §1: the cron's claim on a picture object it means to delete. A claim is written only
-- while no picture row holds the key; an upload that charges the key drops the claim in the
-- same batch, and the cron deletes the object only while its claim stands and no row holds the
-- key. `deleting` marks a claim the cron is acting on: an upload of that key is refused until
-- the cron has deleted the object and dropped the claim, so its bytes can't land in between.
CREATE TABLE picture_tombstones (
  key TEXT PRIMARY KEY,
  claimed_at INTEGER NOT NULL,
  deleting INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX picture_tombstones_claimed ON picture_tombstones (claimed_at);
