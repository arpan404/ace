-- One entry type's catalogue (ADR 0168, ADR 0174 §16): its entries, versions, listing edits,
-- removals, pending withdrawals and transfer offers. Every catalogue database (suits, skills,
-- plugins, bots) has this schema. Every change a reader can see moves this database's `stamp`
-- forward in the batch that makes it, so `/v1/index?since=` never misses one.

-- The last stamp handed out: strictly increasing, from the Worker's clock.
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
INSERT INTO meta (key, value) VALUES ('stamp', 0);

-- A copy of each publisher this catalogue names, kept by the publishers database's sync
-- (ADR 0174 §16): written only when `revision` is newer, and in the same batch the publisher's
-- entries move their generation. `applied_stamp` is the stamp of the batch that wrote it.
-- `live_versions` is this catalogue's own count of the publisher's versions that went live
-- (§9); a copy never overwrites it.
CREATE TABLE publisher_copies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  state TEXT NOT NULL,
  verified INTEGER NOT NULL,
  created INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  applied_stamp INTEGER NOT NULL DEFAULT 0,
  live_versions INTEGER NOT NULL DEFAULT 0
);

-- An entry belongs to the publisher who first published it. Its listing words, latest version
-- and review come from its newest signed version that isn't withdrawn; with none it isn't
-- listed. `listed` means in the index: a live version, listed visibility, not archived, its
-- publisher active (§5). `listing` is an approved listing edit (JSON `MarketListingEdit`)
-- shown over its version's words; `pending_listing` waits for a maintainer. `generation` moves
-- with every change to its versions, in the same batch, so a row computed from versions read
-- earlier is written only if nothing changed since (ADR 0168 §3).
CREATE TABLE entries (
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  publisher TEXT NOT NULL REFERENCES publisher_copies (id),
  title TEXT NOT NULL DEFAULT '',
  line TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  categories TEXT NOT NULL DEFAULT '[]',
  keywords TEXT NOT NULL DEFAULT '[]',
  latest TEXT,
  reviewed INTEGER NOT NULL DEFAULT 0,
  by_ace INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL DEFAULT 0,
  listed INTEGER NOT NULL DEFAULT 0,
  generation INTEGER NOT NULL DEFAULT 0,
  visibility TEXT NOT NULL DEFAULT 'listed',
  archived INTEGER NOT NULL DEFAULT 0,
  latest_pick TEXT,
  listing TEXT,
  pending_listing TEXT,
  first_listed INTEGER,
  verified INTEGER NOT NULL DEFAULT 0,
  deprecated TEXT,
  PRIMARY KEY (type, name)
);
CREATE INDEX entries_listed_updated ON entries (listed, updated);
CREATE INDEX entries_publisher ON entries (publisher);

-- One published version: pending (for the signer), held (for a maintainer), blocked, listed
-- (§8, §9). `listed` once the signer signed its manifest; `listing` is the words the checks
-- read from its files, as JSON. `approved`: a maintainer released its hold, covering its warns.
-- Its scan report is in R2 at `reports/versions/<type>/<name>/<version>.json`, by scanner
-- version `scanned`. `counted` is its download total as last folded from the counts database.
CREATE TABLE versions (
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  hash TEXT NOT NULL,
  size INTEGER NOT NULL,
  published INTEGER NOT NULL,
  listing TEXT NOT NULL,
  listed INTEGER NOT NULL DEFAULT 0,
  manifest TEXT,
  review TEXT,
  reviewed INTEGER NOT NULL DEFAULT 0,
  by_ace INTEGER NOT NULL DEFAULT 0,
  withdrawn TEXT,
  counted INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'pending',
  verdict TEXT,
  block_reason TEXT,
  approved INTEGER NOT NULL DEFAULT 0,
  changelog TEXT NOT NULL DEFAULT '',
  deprecated TEXT,
  scanned INTEGER,
  PRIMARY KEY (type, name, version),
  FOREIGN KEY (type, name) REFERENCES entries (type, name)
);
CREATE INDEX versions_hash ON versions (hash);
CREATE INDEX versions_pending ON versions (listed, published);
CREATE INDEX versions_state ON versions (state, published);

-- Entries that left the index, for `since` answers.
CREATE TABLE removals (
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  stamp INTEGER NOT NULL,
  PRIMARY KEY (type, name)
);
CREATE INDEX removals_stamp ON removals (stamp);

-- A publisher's withdrawal waiting for the signer to sign it into the list.
CREATE TABLE pending_withdrawals (
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  hash TEXT NOT NULL,
  reason TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (type, name, version)
);

-- The newest signed list (by `issued`) this catalogue marked its versions by: `withdrawn`
-- (ADR 0174 §16). The list itself is in the lists database; marking it here is one batch.
CREATE TABLE applied_lists (
  name TEXT PRIMARY KEY,
  issued INTEGER NOT NULL
);

-- An entry offered to another publisher (§5); one offer per entry, for 7 days. Kept with the
-- entry, so accepting moves the owner only while the offer stands, in one statement.
CREATE TABLE transfers (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  from_publisher TEXT NOT NULL REFERENCES publisher_copies (id),
  to_publisher TEXT NOT NULL REFERENCES publisher_copies (id),
  at INTEGER NOT NULL,
  expires INTEGER NOT NULL,
  UNIQUE (type, name)
);
CREATE INDEX transfers_to ON transfers (to_publisher);
CREATE INDEX transfers_from ON transfers (from_publisher);
CREATE INDEX transfers_expires ON transfers (expires);
