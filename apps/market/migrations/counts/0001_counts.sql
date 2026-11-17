-- Download counts and what is ranked from them (ADR 0168 §3, §10; ADR 0174 §6, §16). Counts
-- only: nothing names who fetched.

-- Trending's pass and when it last ranked.
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

-- Every fetch of a listed version's bytes, per version. `folded` is the total the cron last
-- wrote into the version's catalogue (`versions.counted`), so the index moves an entry's stamp
-- once per fold, not once per download.
CREATE TABLE version_totals (
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  downloads INTEGER NOT NULL DEFAULT 0,
  folded INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (type, name, version)
);
CREATE INDEX version_totals_unfolded ON version_totals (type) WHERE downloads != folded;

-- Per entry per hour for trending (kept 15 days) and per entry per day for top publishers
-- (kept 45 days): each fetch is credited once, to the entry that listed its bytes first.
CREATE TABLE downloads_hourly (
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  hour INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (type, name, hour)
);
CREATE INDEX downloads_hourly_hour ON downloads_hourly (hour);
CREATE TABLE credited_daily (
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  day INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (type, name, day)
);
CREATE INDEX credited_daily_day ON credited_daily (day);
-- Per version per day for publishers' signals (kept 400 days). The table that grows most: shard
-- it by month before the database nears 5 GB (§16).
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
  publisher TEXT NOT NULL,
  downloads INTEGER NOT NULL,
  entries INTEGER NOT NULL
);

-- What the cron recorded once a day so growth can be watched (§16): each database's size in
-- bytes, and each table's rows.
CREATE TABLE database_sizes (
  day INTEGER NOT NULL,
  database TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  PRIMARY KEY (day, database)
);
CREATE TABLE table_rows (
  day INTEGER NOT NULL,
  database TEXT NOT NULL,
  name TEXT NOT NULL,
  rows INTEGER NOT NULL,
  PRIMARY KEY (day, database, name)
);
