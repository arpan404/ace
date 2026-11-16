-- ADR 0173: publisher profiles, publications publishers manage, Discover, abuse reports and the
-- scan pipeline. Every table here is the market's own; nothing in it names a reader. Download
-- buckets and reports are anonymous totals and words, never an address or an account.

-- A publisher's profile (§3). `name` stays the handle. `skeleton` is the handle's confusable
-- folding, unique, so lookalike handles can't both exist; rows from before are filled by the cron.
ALTER TABLE publishers ADD COLUMN skeleton TEXT;
ALTER TABLE publishers ADD COLUMN display_name TEXT NOT NULL DEFAULT '';
ALTER TABLE publishers ADD COLUMN bio TEXT NOT NULL DEFAULT '';
ALTER TABLE publishers ADD COLUMN links TEXT NOT NULL DEFAULT '[]';
ALTER TABLE publishers ADD COLUMN avatar TEXT;
ALTER TABLE publishers ADD COLUMN verified INTEGER NOT NULL DEFAULT 0;
-- active | suspended | deleted; only maintainers move it (§2).
ALTER TABLE publishers ADD COLUMN state TEXT NOT NULL DEFAULT 'active';
ALTER TABLE publishers ADD COLUMN state_reason TEXT;
-- Up to six of the publisher's own entries, as JSON `[{type, name}]`, in order.
ALTER TABLE publishers ADD COLUMN pins TEXT NOT NULL DEFAULT '[]';
-- How many of its versions ever went live: under three, it is a new publisher (§9).
ALTER TABLE publishers ADD COLUMN live_versions INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX publishers_skeleton ON publishers (skeleton);

-- A handle given up stays its account's, so nobody else can take it and pose as them (§3).
CREATE TABLE retired_handles (
  skeleton TEXT PRIMARY KEY,
  handle TEXT NOT NULL,
  publisher TEXT NOT NULL REFERENCES publishers (id),
  at INTEGER NOT NULL
);

-- An entry's management (§5). `listed` keeps meaning "in the index": a live version, listed
-- visibility, not archived, its publisher active. `listing` is an approved listing edit (JSON
-- `MarketListingEdit`) shown over its version's words; `pending_listing` waits for a maintainer.
ALTER TABLE entries ADD COLUMN visibility TEXT NOT NULL DEFAULT 'listed';
ALTER TABLE entries ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
ALTER TABLE entries ADD COLUMN latest_pick TEXT;
ALTER TABLE entries ADD COLUMN listing TEXT;
ALTER TABLE entries ADD COLUMN pending_listing TEXT;
ALTER TABLE entries ADD COLUMN first_listed INTEGER;
ALTER TABLE entries ADD COLUMN verified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE entries ADD COLUMN deprecated TEXT;
CREATE INDEX entries_publisher ON entries (publisher);

-- A version's way through the scan and the signer (§8, §9): pending (for the signer), held (for
-- a maintainer), blocked, listed. `approved`: a maintainer released its hold, covering its warns.
-- Its scan report is in R2 at `reports/versions/<type>/<name>/<version>.json`, by scanner
-- version `scanned`.
ALTER TABLE versions ADD COLUMN state TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE versions ADD COLUMN verdict TEXT;
ALTER TABLE versions ADD COLUMN block_reason TEXT;
ALTER TABLE versions ADD COLUMN approved INTEGER NOT NULL DEFAULT 0;
ALTER TABLE versions ADD COLUMN changelog TEXT NOT NULL DEFAULT '';
ALTER TABLE versions ADD COLUMN deprecated TEXT;
ALTER TABLE versions ADD COLUMN scanned INTEGER;
-- The versions this Worker listed before scanning existed are listed; the table is small.
UPDATE versions SET state = 'listed' WHERE listed = 1;
CREATE INDEX versions_state ON versions (state, published);

-- Drafts (§5): bytes at `drafts/<id>`, the scan's report at `reports/drafts/<id>.json`.
CREATE TABLE drafts (
  id TEXT PRIMARY KEY,
  publisher TEXT NOT NULL REFERENCES publishers (id),
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  hash TEXT NOT NULL,
  size INTEGER NOT NULL,
  files INTEGER NOT NULL,
  title TEXT NOT NULL,
  changelog TEXT NOT NULL DEFAULT '',
  problems TEXT NOT NULL DEFAULT '[]',
  -- scanning | done
  scan_state TEXT NOT NULL,
  verdict TEXT,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX drafts_publisher ON drafts (publisher, updated);
CREATE INDEX drafts_updated ON drafts (updated);

-- A scan that didn't fit one request, carried on by later requests and the cron (§8). `state`
-- is the scanner's own resumable state as JSON; `cursor` the next file.
CREATE TABLE scan_jobs (
  draft TEXT PRIMARY KEY REFERENCES drafts (id) ON DELETE CASCADE,
  cursor INTEGER NOT NULL,
  files INTEGER NOT NULL,
  state TEXT NOT NULL,
  updated INTEGER NOT NULL
);

-- Uploads a publisher made each day, for its daily limit (§9). Publishers are accounts, not
-- readers; nothing here names a reader.
CREATE TABLE upload_days (
  publisher TEXT NOT NULL,
  day INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (publisher, day)
);

-- An entry offered to another publisher (§5); one offer per entry, for 7 days.
CREATE TABLE transfers (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  from_publisher TEXT NOT NULL REFERENCES publishers (id),
  to_publisher TEXT NOT NULL REFERENCES publishers (id),
  at INTEGER NOT NULL,
  expires INTEGER NOT NULL,
  UNIQUE (type, name)
);
CREATE INDEX transfers_to ON transfers (to_publisher);

-- A publisher's answer to a block or a hold (§5); maintainers answer it (§9).
CREATE TABLE appeals (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  publisher TEXT NOT NULL REFERENCES publishers (id),
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

-- Anonymous abuse reports (§7): no address, no account.
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

-- Download totals over time (§6): per entry per hour for trending (kept 15 days), per version per
-- day for publishers' signals (kept 400 days). Counts only.
CREATE TABLE downloads_hourly (
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  hour INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (type, name, hour)
);
CREATE INDEX downloads_hourly_hour ON downloads_hourly (hour);
CREATE TABLE downloads_daily (
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  day INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (type, name, version, day)
);
CREATE INDEX downloads_daily_day ON downloads_daily (day);

-- Trending as last ranked, and the pass being built in steps; swapped when a pass completes.
-- `movement` is JSON `MarketTrendMovement`.
CREATE TABLE trending (
  rank INTEGER PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  score REAL NOT NULL,
  week INTEGER NOT NULL,
  movement TEXT NOT NULL
);
CREATE TABLE trending_scores (
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  score REAL NOT NULL,
  week INTEGER NOT NULL,
  -- The same ranking's score a week earlier, for movement.
  before REAL NOT NULL,
  PRIMARY KEY (type, name)
);
CREATE TABLE top_publishers (
  rank INTEGER PRIMARY KEY,
  publisher TEXT NOT NULL REFERENCES publishers (id),
  downloads INTEGER NOT NULL,
  entries INTEGER NOT NULL
);

-- The maintainers' collections (§6), in order; `entries` is JSON `[{type, name}]`.
CREATE TABLE collections (
  position INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  line TEXT NOT NULL,
  entries TEXT NOT NULL
);

-- The signed blocklist (§8), newest `issued` only.
CREATE TABLE blocklist (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  issued INTEGER NOT NULL,
  signed TEXT NOT NULL
);

-- Publisher verification (§13). `verification` is the publisher's state: none | applied |
-- verified | revoked, with the proofs that passed (JSON), the reason a maintainer gave and a
-- failed re-check's flag. The signed verified list is stored like the withdrawn list.
ALTER TABLE publishers ADD COLUMN verification TEXT NOT NULL DEFAULT 'none';
ALTER TABLE publishers ADD COLUMN proofs TEXT NOT NULL DEFAULT '[]';
ALTER TABLE publishers ADD COLUMN verification_reason TEXT;
ALTER TABLE publishers ADD COLUMN verification_flag TEXT;
ALTER TABLE publishers ADD COLUMN verification_at INTEGER;
ALTER TABLE publishers ADD COLUMN rechecked INTEGER NOT NULL DEFAULT 0;
-- A proof token: random, single use (spent once it passes), expiring.
CREATE TABLE verification_challenges (
  publisher TEXT NOT NULL REFERENCES publishers (id),
  -- domain | github
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  expires INTEGER NOT NULL,
  -- waiting | passed | failed
  state TEXT NOT NULL DEFAULT 'waiting',
  problem TEXT,
  PRIMARY KEY (publisher, kind)
);
CREATE TABLE verified (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  issued INTEGER NOT NULL,
  signed TEXT NOT NULL
);

-- The signed official list (§14): which accounts publish as `ace`. Newest `issued` only; the
-- accounts are copied out (`official_accounts`) for the per-request check.
CREATE TABLE official (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  issued INTEGER NOT NULL,
  signed TEXT NOT NULL
);
CREATE TABLE official_accounts (
  account TEXT PRIMARY KEY,
  publisher TEXT NOT NULL REFERENCES publishers (id)
);
