-- ace's marketplace (ADR 0168). Every change a reader can see moves `stamp` forward, so
-- `/v1/index?since=` never misses one.

-- The last stamp handed out: strictly increasing, from the Worker's clock.
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
INSERT INTO meta (key, value) VALUES ('stamp', 0);

-- A publisher is an ace account's id and the name it picked, and nothing else from the account.
-- `id` is the market's own, the one manifests and listings show.
CREATE TABLE publishers (
  id TEXT PRIMARY KEY,
  account TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL UNIQUE,
  created INTEGER NOT NULL
);

-- An entry belongs to the publisher who first published it. Its listing words, latest version
-- and review come from its newest signed version that isn't withdrawn; with none it isn't
-- listed.
CREATE TABLE entries (
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  publisher TEXT NOT NULL REFERENCES publishers (id),
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
  PRIMARY KEY (type, name)
);
CREATE INDEX entries_listed_updated ON entries (listed, updated);

-- One published version. `listed` once the signer signed its manifest; `listing` is the words
-- the checks read from its files, as JSON.
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
  downloads INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (type, name, version),
  FOREIGN KEY (type, name) REFERENCES entries (type, name)
);
CREATE INDEX versions_hash ON versions (hash);
CREATE INDEX versions_pending ON versions (listed, published);

-- Entries that left the index, for `since` answers.
CREATE TABLE removals (
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  stamp INTEGER NOT NULL,
  PRIMARY KEY (type, name)
);
CREATE INDEX removals_stamp ON removals (stamp);

-- The maintainers' lists, in order.
CREATE TABLE categories (
  position INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL
);
CREATE TABLE featured (
  position INTEGER PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL
);

-- The signed withdrawn list, newest `issued` only.
CREATE TABLE withdrawn (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  issued INTEGER NOT NULL,
  signed TEXT NOT NULL
);

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
