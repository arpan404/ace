-- ace search's counters (ADR 0210 §4): how many searches a scope (the whole service, an account,
-- a machine or a caller address) made in a period (a UTC day or month). Counts only: no query
-- text, no results. A new table, empty at open: nothing existing is rewritten (ADR 0170).
CREATE TABLE search_counts (
  scope TEXT NOT NULL,
  period TEXT NOT NULL,
  count INTEGER NOT NULL,
  -- When the period ends (ms since the epoch): the hourly sweep drops rows past it.
  until INTEGER NOT NULL,
  PRIMARY KEY (scope, period)
) STRICT;
CREATE INDEX search_counts_until ON search_counts (until);

-- A cloud credential searches only while its machine holds a live machine credential on the
-- account (ADR 0210 §3), checked on every search by host and account. machine_credentials has
-- one row per signed-in machine, so this index is small.
CREATE INDEX machine_credentials_host ON machine_credentials (host_id, account_id);
