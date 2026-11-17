-- ADR 0174 §16: refresh work that must survive a cut-off, written in the batch that makes it.

-- Entries a withdrawn list's marks touched, waiting to be brought in step. The marking batch
-- writes a row per affected entry; a row is removed only after its entry was refreshed and only
-- while `queued` is still the value read, so an entry queued again meanwhile is refreshed again.
-- `applied_lists` row `withdrawn:refreshed` is the newest list whose queue was fully drained.
CREATE TABLE refresh_queue (
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  queued INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (type, name)
);

-- A publisher copy whose entries are still being brought in step, a page at a time: `after` is
-- the last entry name refreshed for copy `revision`. Written in the batch that writes the copy;
-- removed only when the last page of that revision is done.
CREATE TABLE copy_refreshes (
  publisher TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  after TEXT NOT NULL DEFAULT ''
);
