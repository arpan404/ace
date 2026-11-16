-- ADR 0173 §3, §5, §9: handles reserved in one table, and pictures charged to their publisher.

-- Every handle skeleton in use or given up, owned by the account that holds it (§3). The
-- primary key is what refuses a second claim of a skeleton: a publisher row that takes a
-- skeleton another account holds, active or retired, fails in the statement that writes it.
-- A handle given up stays `retired` and its account's, so only that account can take it back.
-- `retired_handles` is kept for the rows written before; this table is the one that decides.
CREATE TABLE handle_reservations (
  skeleton TEXT PRIMARY KEY,
  account TEXT NOT NULL,
  publisher TEXT NOT NULL REFERENCES publishers (id),
  handle TEXT NOT NULL,
  retired INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX handle_reservations_publisher ON handle_reservations (publisher);

INSERT INTO handle_reservations (skeleton, account, publisher, handle, retired)
  SELECT skeleton, account, id, name, 0 FROM publishers WHERE skeleton IS NOT NULL;
INSERT INTO handle_reservations (skeleton, account, publisher, handle, retired)
  SELECT r.skeleton, p.account, r.publisher, r.handle, 1
    FROM retired_handles r JOIN publishers p ON p.id = r.publisher WHERE true
  ON CONFLICT (skeleton) DO NOTHING;

-- Every write of a publisher's skeleton reserves it in the same statement: a new publisher (a
-- profile, a first publish, the cron's skeleton for an old row) and a rename, which retires
-- the old skeleton for its account. The account's own retired skeleton is taken back; any
-- other account's row makes the insert fail on the primary key.
CREATE TRIGGER publishers_reserve_new AFTER INSERT ON publishers
  WHEN NEW.skeleton IS NOT NULL
BEGIN
  DELETE FROM handle_reservations
    WHERE skeleton = NEW.skeleton AND account = NEW.account AND retired = 1;
  INSERT INTO handle_reservations (skeleton, account, publisher, handle, retired)
    VALUES (NEW.skeleton, NEW.account, NEW.id, NEW.name, 0);
END;

CREATE TRIGGER publishers_reserve_change AFTER UPDATE OF skeleton ON publishers
  WHEN NEW.skeleton IS NOT NULL AND NEW.skeleton IS NOT OLD.skeleton
BEGIN
  UPDATE handle_reservations SET retired = 1, handle = OLD.name
    WHERE skeleton = OLD.skeleton AND account = NEW.account;
  DELETE FROM handle_reservations
    WHERE skeleton = NEW.skeleton AND account = NEW.account AND retired = 1;
  INSERT INTO handle_reservations (skeleton, account, publisher, handle, retired)
    VALUES (NEW.skeleton, NEW.account, NEW.id, NEW.name, 0);
END;

-- Pictures a publisher stored (§3 avatars, §5 listing pictures), keyed by their R2 key, so their
-- bytes count against the quota (§9). The row is written before the bytes and the profile or
-- listing names them only after, so a cut-off upload leaves a row or an object nothing names;
-- the cron drops rows nothing names after a grace period, then objects with no row.
CREATE TABLE pictures (
  key TEXT NOT NULL,
  publisher TEXT NOT NULL REFERENCES publishers (id),
  size INTEGER NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (key, publisher)
);
CREATE INDEX pictures_publisher ON pictures (publisher);
CREATE INDEX pictures_at ON pictures (at);

-- Pictures from before are kept with no size: their bytes were never charged.
INSERT INTO pictures (key, publisher, size, at)
  SELECT 'avatars/' || avatar, id, 0, 0 FROM publishers WHERE avatar IS NOT NULL;
INSERT INTO pictures (key, publisher, size, at)
  SELECT DISTINCT 'previews/' || p.value, e.publisher, 0, 0 FROM entries e,
    json_each(COALESCE(json_extract(e.listing, '$.previews'), '[]')) p WHERE true
  ON CONFLICT (key, publisher) DO NOTHING;
INSERT INTO pictures (key, publisher, size, at)
  SELECT DISTINCT 'previews/' || p.value, e.publisher, 0, 0 FROM entries e,
    json_each(COALESCE(json_extract(e.pending_listing, '$.listing.previews'), '[]')) p WHERE true
  ON CONFLICT (key, publisher) DO NOTHING;

-- Where the cron's walk of an R2 prefix got to, so each run lists one bounded page.
CREATE TABLE sweep_cursors (
  prefix TEXT PRIMARY KEY,
  after TEXT NOT NULL
);
