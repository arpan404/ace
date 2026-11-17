-- Publishers and what is theirs (ADR 0174 §2, §3, §5, §9, §13, §14, §16): accounts, profiles,
-- handle reservations, verification, the official list, drafts and their scans, upload limits,
-- the quota ledger and pictures. A publisher is an ace account's id and the handle it picked;
-- nothing else from the account. Nothing here names a reader.

-- `id` is the market's own, the one manifests and listings show; `name` is the handle and
-- `skeleton` its confusable folding, unique, so lookalike handles can't both exist. `state` is
-- active | suspended | deleted; only maintainers move it (§2). `pins`: up to six of the
-- publisher's own entries, JSON `[{type, name}]`, in order. `verification` is none | applied |
-- verified | revoked; `proofs` the latest application's, `approved_proofs` what the signed
-- verified list granted the mark on.
--
-- Each catalogue keeps a copy of `name`, `state`, `verified` and `created` (§16). `revision`
-- moves in the statement that changes any of them (the trigger below); `synced` is the revision
-- every catalogue has applied. `usage_dirty` is when the publisher's charges last changed
-- without a reconcile; `usage_checked` when the cron last reconciled them.
CREATE TABLE publishers (
  id TEXT PRIMARY KEY,
  account TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL UNIQUE,
  created INTEGER NOT NULL,
  skeleton TEXT,
  display_name TEXT NOT NULL DEFAULT '',
  bio TEXT NOT NULL DEFAULT '',
  links TEXT NOT NULL DEFAULT '[]',
  avatar TEXT,
  verified INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'active',
  state_reason TEXT,
  pins TEXT NOT NULL DEFAULT '[]',
  verification TEXT NOT NULL DEFAULT 'none',
  proofs TEXT NOT NULL DEFAULT '[]',
  approved_proofs TEXT NOT NULL DEFAULT '[]',
  verification_reason TEXT,
  verification_flag TEXT,
  verification_at INTEGER,
  rechecked INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  synced INTEGER NOT NULL DEFAULT 0,
  usage_dirty INTEGER,
  usage_checked INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX publishers_skeleton ON publishers (skeleton);
CREATE INDEX publishers_unsynced ON publishers (id) WHERE synced < revision;
CREATE INDEX publishers_usage ON publishers (usage_dirty, usage_checked);

CREATE TRIGGER publishers_revision AFTER UPDATE OF name, state, verified ON publishers
  WHEN NEW.name IS NOT OLD.name OR NEW.state IS NOT OLD.state
    OR NEW.verified IS NOT OLD.verified
BEGIN
  UPDATE publishers SET revision = revision + 1 WHERE id = NEW.id;
END;

-- Every handle skeleton in use or given up, owned by the account that holds it (§3). The
-- primary key is what refuses a second claim of a skeleton: a publisher row that takes a
-- skeleton another account holds, active or retired, fails in the statement that writes it.
-- A handle given up stays `retired` and its account's, so only that account can take it back.
CREATE TABLE handle_reservations (
  skeleton TEXT PRIMARY KEY,
  account TEXT NOT NULL,
  publisher TEXT NOT NULL REFERENCES publishers (id),
  handle TEXT NOT NULL,
  retired INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX handle_reservations_publisher ON handle_reservations (publisher);

-- Every write of a publisher's skeleton reserves it in the same statement: a new publisher (a
-- profile, a first publish, the cron's skeleton for a row without one) and a rename, which
-- retires the old skeleton for its account. The account's own retired skeleton is taken back;
-- any other account's row makes the insert fail on the primary key.
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

-- A proof token (§13): random, single use (spent once it passes), expiring.
CREATE TABLE verification_challenges (
  publisher TEXT NOT NULL REFERENCES publishers (id),
  -- domain | github, or <kind>:approved for the one a mark was granted on
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  expires INTEGER NOT NULL,
  -- waiting | passed | failed
  state TEXT NOT NULL DEFAULT 'waiting',
  problem TEXT,
  PRIMARY KEY (publisher, kind)
);

-- The signed verified list (§13), newest `issued` only: stored in the batch that marks the
-- publishers on it.
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

-- Drafts (§5): bytes at `drafts/<id>/<hash>`, the scan's report at
-- `reports/drafts/<id>/<hash>.json`. `publishing` is the version (`type/name/version`) a publish
-- has claimed the draft for (§16): set only while the draft holds the scanned hash with its
-- scan done, and in the same batch its bytes move onto that version's charge (its `size`
-- stops counting). A claimed draft can't be replaced, edited or deleted.
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
  updated INTEGER NOT NULL,
  publishing TEXT,
  publishing_at INTEGER
);
CREATE INDEX drafts_publisher ON drafts (publisher, updated);
CREATE INDEX drafts_updated ON drafts (updated);
CREATE INDEX drafts_publishing ON drafts (publishing_at) WHERE publishing IS NOT NULL;

-- A scan that didn't fit one request, carried on by later requests and the cron (§8). `state`
-- is the scanner's own resumable state as JSON; `cursor` the next file.
CREATE TABLE scan_jobs (
  draft TEXT PRIMARY KEY REFERENCES drafts (id) ON DELETE CASCADE,
  cursor INTEGER NOT NULL,
  files INTEGER NOT NULL,
  state TEXT NOT NULL,
  updated INTEGER NOT NULL
);

-- Uploads a publisher made each day, for its daily limit (§9).
CREATE TABLE upload_days (
  publisher TEXT NOT NULL,
  day INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (publisher, day)
);

-- The quota ledger (§9, §16): one charge per stored version that isn't blocked, keyed
-- `type/name/version`, written before the version is. A publisher's stored bytes are its
-- drafts, pictures and charges, summed in the statement that reserves more. Only the cron's
-- reconcile drops or corrects a charge, and never one younger than its grace period. `nonce`
-- is the request that last wrote it.
CREATE TABLE charges (
  item TEXT PRIMARY KEY,
  publisher TEXT NOT NULL,
  size INTEGER NOT NULL,
  at INTEGER NOT NULL,
  nonce TEXT NOT NULL DEFAULT ''
);
CREATE INDEX charges_publisher ON charges (publisher);

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

-- The cron's claim on a picture object it means to delete (§1). A claim is written only while no
-- picture row holds the key; an upload that charges the key drops the claim in the same batch,
-- and the cron deletes the object only while its claim stands and no row holds the key.
-- `deleting` marks a claim the cron is acting on: an upload of that key is refused until the cron
-- has deleted the object and dropped the claim, so its bytes can't land in between. One sweep at
-- a time acts on a claim: `owner` is the id of the cron run that holds it, `generation` goes up
-- each time a run takes or renews it, and `leased_at` is when it did. A run takes a claim only
-- while it is unowned, its own, or its lease has lapsed, and deletes the object only after
-- re-checking that it still holds that owner and generation, so a slow run that lost the claim
-- deletes nothing.
CREATE TABLE picture_tombstones (
  key TEXT PRIMARY KEY,
  claimed_at INTEGER NOT NULL,
  deleting INTEGER NOT NULL DEFAULT 0,
  owner TEXT,
  generation INTEGER NOT NULL DEFAULT 0,
  leased_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX picture_tombstones_claimed ON picture_tombstones (claimed_at);

-- Where the cron's walk of an R2 prefix got to, so each run lists one bounded page.
CREATE TABLE sweep_cursors (
  prefix TEXT PRIMARY KEY,
  after TEXT NOT NULL
);
