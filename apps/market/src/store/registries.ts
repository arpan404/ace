import type { MarketPublisher, RegistryEntry, RegistryKeyLink } from "@ace/protocol/marketplace";
import { fromCatalogues, type Databases } from "./databases.ts";

/*
 * Organizations' registries (ADR 0206 §5.1) in the `market-orgs` database: which publisher is an
 * organization's, who an owner named as its publishers, and its key chain. Its entries are in
 * their type's catalogues, marked with the audience `org:<id>`.
 */

export const orgAudience = (org: string) => `org:${org}`;

/**
 * How an entry's name is stored: as it is for the public market, `<name>@<org>` for an
 * organization's registry. A public name can't hold `@`, so a registry's entry never meets a
 * public one or another organization's: each audience has its own names, and a public lookup
 * can't reach a private row.
 */
export const storedName = (name: string, org?: string) =>
  org === undefined ? name : `${name}@${org}`;
/** Whether a stored name is a registry's (`<name>@<org>`). */
export const isRegistryName = (stored: string) => stored.includes("@");
/** The name a stored entry is shown and signed under. */
export const shownName = (stored: string) => stored.split("@")[0] ?? stored;
/** The organization an entry's audience names, or undefined for a public entry. */
export const audienceOrg = (audience: string): string | undefined =>
  audience.startsWith("org:") ? audience.slice(4) : undefined;

export interface Registry {
  org: string;
  publisher: MarketPublisher;
}

/** The organization's registry and its publisher, if it has one. */
export async function registryOf(dbs: Databases, org: string): Promise<Registry | undefined> {
  if (!dbs.orgs) return undefined;
  const row = await dbs.orgs
    .prepare("SELECT publisher FROM registries WHERE org = ?1")
    .bind(org)
    .first<{ publisher: string }>();
  if (!row) return undefined;
  const publisher = await dbs.publishers
    .prepare("SELECT id, name FROM publishers WHERE id = ?1")
    .bind(row.publisher)
    .first<MarketPublisher>();
  return publisher ? { org, publisher: { id: publisher.id, name: publisher.name } } : undefined;
}

/** Records `publisher` as `org`'s registry; false when the organization has one already. */
export async function recordRegistry(
  orgs: D1Database,
  input: { org: string; publisher: string; account: string; now: number },
): Promise<boolean> {
  const result = await orgs
    .prepare(
      `INSERT INTO registries (org, publisher, created, created_by) VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT DO NOTHING`,
    )
    .bind(input.org, input.publisher, input.now, input.account)
    .run();
  return result.meta.changes === 1;
}

/** Whether an owner named `account` as one of the registry's publishers. */
export async function namedPublisher(
  orgs: D1Database,
  org: string,
  account: string,
): Promise<boolean> {
  const row = await orgs
    .prepare("SELECT 1 AS found FROM registry_publishers WHERE org = ?1 AND account = ?2")
    .bind(org, account)
    .first();
  return row !== null;
}

export interface StoredKey {
  position: number;
  keyId: string;
  publicKey: string;
  link: RegistryKeyLink;
}

/** The registry's key chain, first first. */
export async function registryKeys(orgs: D1Database, org: string): Promise<StoredKey[]> {
  const { results } = await orgs
    .prepare(
      `SELECT position, key_id, public_key, upload, attestation FROM registry_keys
        WHERE org = ?1 ORDER BY position`,
    )
    .bind(org)
    .all<{
      position: number;
      key_id: string;
      public_key: string;
      upload: string;
      attestation: string;
    }>();
  return results.map((row) => ({
    position: row.position,
    keyId: row.key_id,
    publicKey: row.public_key,
    link: { upload: row.upload, attestation: row.attestation },
  }));
}

/** The key the registry signs with now: its chain's last. */
export async function currentKey(
  orgs: D1Database,
  org: string,
): Promise<{ id: string; publicKey: string } | undefined> {
  const row = await orgs
    .prepare(
      `SELECT key_id, public_key FROM registry_keys WHERE org = ?1
        ORDER BY position DESC LIMIT 1`,
    )
    .bind(org)
    .first<{ key_id: string; public_key: string }>();
  return row ? { id: row.key_id, publicKey: row.public_key } : undefined;
}

/** The chain as one request verifies it: its keys and the revision they were read at. */
export async function chainState(
  orgs: D1Database,
  org: string,
): Promise<{ revision: number; keys: StoredKey[] }> {
  const [row, keys] = await Promise.all([
    orgs
      .prepare("SELECT chain_revision FROM registries WHERE org = ?1")
      .bind(org)
      .first<{ chain_revision: number }>(),
    registryKeys(orgs, org),
  ]);
  return { revision: row?.chain_revision ?? 0, keys };
}

export interface KeyWrite {
  org: string;
  position: number;
  keyId: string;
  publicKey: string;
  upload: string;
  attestation: string;
  addedBy: string;
  at: number;
  /** The chain revision the request verified the key against (`chainState`). */
  revision: number;
  /** For a later key: the exact upload of the key before it, as verified. */
  previousUpload: string | undefined;
  /** This write's own token: the statements after the first act only if it moved the chain. */
  writer: string;
}

/**
 * Adds a key to the chain, in one batch, only while the chain is still at the revision the
 * request verified: a first key replaces the whole chain (a reset); a later key also needs the
 * exact upload it was verified to follow at `position - 1`, and nothing at or after it. A reset
 * and a rotation racing, or two rotations, can't both land, nor one land on a chain it never
 * verified. False when nothing was written.
 */
export async function addKey(orgs: D1Database, write: KeyWrite): Promise<boolean> {
  const moved = "EXISTS (SELECT 1 FROM registries WHERE org = ?1 AND chain_writer = ?9)";
  const follows =
    write.position === 0
      ? ""
      : `AND EXISTS (SELECT 1 FROM registry_keys WHERE org = ?1 AND position = ?2 - 1
            AND upload = ?3)
          AND NOT EXISTS (SELECT 1 FROM registry_keys WHERE org = ?1 AND position >= ?2)`;
  const claim = orgs
    .prepare(
      `UPDATE registries SET chain_revision = chain_revision + 1, chain_writer = ?4
        WHERE org = ?1 AND chain_revision = ?5 ${follows}`,
    )
    .bind(write.org, write.position, write.previousUpload ?? "", write.writer, write.revision);
  const insert = orgs
    .prepare(
      `INSERT INTO registry_keys
          (org, position, key_id, public_key, upload, attestation, added_by, at)
        SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8 WHERE ${moved}`,
    )
    .bind(
      write.org,
      write.position,
      write.keyId,
      write.publicKey,
      write.upload,
      write.attestation,
      write.addedBy,
      write.at,
      write.writer,
    );
  const reset = orgs
    .prepare(`DELETE FROM registry_keys WHERE org = ?1 AND ${moved.replace("?9", "?2")}`)
    .bind(write.org, write.writer);
  const results = await orgs.batch(write.position === 0 ? [claim, reset, insert] : [claim, insert]);
  return (results.at(-1)?.meta.changes ?? 0) === 1;
}

/** Who may read an entry: `public`, or the organization's audience; undefined for no entry. */
export async function audienceOf(
  db: D1Database,
  type: string,
  name: string,
): Promise<string | undefined> {
  const row = await db
    .prepare("SELECT audience FROM entries WHERE type = ?1 AND name = ?2")
    .bind(type, name)
    .first<{ audience: string }>();
  return row?.audience;
}

/** Marks a new entry as the organization's: unlisted, so no public list ever shows it. */
export async function claimForOrg(
  db: D1Database,
  input: { type: string; name: string; publisher: string; org: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO entries (type, name, publisher, title, visibility, audience)
        VALUES (?1, ?2, ?3, ?5, 'unlisted', ?4) ON CONFLICT DO NOTHING`,
    )
    .bind(
      input.type,
      storedName(input.name, input.org),
      input.publisher,
      orgAudience(input.org),
      input.name,
    )
    .run();
}

/** Every entry of the organization's registry, over every catalogue. */
export async function registryEntries(dbs: Databases, org: string): Promise<RegistryEntry[]> {
  return fromCatalogues(dbs, async ({ type, db }) => {
    const { results } = await db
      .prepare(
        `SELECT name, title, latest FROM entries WHERE audience = ?1 AND archived = 0
          ORDER BY name LIMIT 5000`,
      )
      .bind(orgAudience(org))
      .all<{ name: string; title: string; latest: string | null }>();
    return results.map((row) => {
      const name = shownName(row.name);
      const title = row.title === row.name ? name : row.title;
      const entry: RegistryEntry = { type, name, title: title.slice(0, 120) };
      if (row.latest) entry.latest = row.latest;
      return entry;
    });
  });
}
