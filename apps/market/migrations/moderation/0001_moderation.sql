-- Moderation (ADR 0173 §5, §7, §8, §16): abuse reports, appeals and the signed blocklist.
-- Nothing here names a reader: reports keep no address and no account.

-- Anonymous abuse reports (§7). An entry holds at most 500 open ones.
CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT,
  reason TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  at INTEGER NOT NULL,
  -- open | dismissed | kept | withdrawn | blocked
  state TEXT NOT NULL DEFAULT 'open',
  outcome TEXT,
  resolved INTEGER
);
CREATE INDEX reports_entry ON reports (type, name, state);
CREATE INDEX reports_state ON reports (state, at);

-- A publisher's answer to a block or a hold (§5); maintainers answer it (§9). One open appeal
-- per version.
CREATE TABLE appeals (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  publisher TEXT NOT NULL,
  note TEXT NOT NULL,
  replacement TEXT,
  at INTEGER NOT NULL,
  -- open | approved | kept
  state TEXT NOT NULL DEFAULT 'open',
  answer TEXT,
  answered INTEGER
);
CREATE INDEX appeals_state ON appeals (state, at);
CREATE INDEX appeals_version ON appeals (type, name, version);

-- The signed blocklist (§8), newest `issued` only.
CREATE TABLE blocklist (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  issued INTEGER NOT NULL,
  signed TEXT NOT NULL
);
