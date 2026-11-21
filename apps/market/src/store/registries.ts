import type { MarketPublisher, RegistryEntry, RegistryKeyLink } from "@ace/protocol/marketplace";
import { fromCatalogues, type Databases } from "./databases.ts";

/*
 * Organizations' registries (ADR 0206 §5.1) in the `market-orgs` database: which publisher is an
 * organization's, who an owner named as its publishers, and its key chain. Its entries are in
 * their type's catalogues, marked with the audience `org:<id>`.
 */

export const orgAudience = (org: string) => `org:${org}`;
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
      `SELECT position, key_id, public_key, upload, grant_token FROM registry_keys
        WHERE org = ?1 ORDER BY position`,
    )
    .bind(org)
    .all<{
      position: number;
      key_id: string;
      public_key: string;
      upload: string;
      grant_token: string;
    }>();
  return results.map((row) => ({
    position: row.position,
    keyId: row.key_id,
    publicKey: row.public_key,
    link: { upload: row.upload, grant: row.grant_token },
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

export interface KeyWrite {
  org: string;
  position: number;
  keyId: string;
  publicKey: string;
  previous: string | undefined;
  upload: string;
  grant: string;
  addedBy: string;
  at: number;
}

/**
 * Adds a key to the chain. A first key replaces the whole chain (a reset), in one batch; a later
 * key is written only while the chain ends, at `position - 1`, with the key it names as previous,
 * so two rotations racing can't both land. False when nothing was written.
 */
export async function addKey(orgs: D1Database, write: KeyWrite): Promise<boolean> {
  const values = [
    write.org,
    write.position,
    write.keyId,
    write.publicKey,
    write.upload,
    write.grant,
    write.addedBy,
    write.at,
  ];
  const insert = `INSERT INTO registry_keys
      (org, position, key_id, public_key, upload, grant_token, added_by, at)`;
  if (write.position === 0) {
    const [, inserted] = await orgs.batch([
      orgs.prepare("DELETE FROM registry_keys WHERE org = ?1").bind(write.org),
      orgs.prepare(`${insert} VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`).bind(...values),
    ]);
    return (inserted?.meta.changes ?? 0) === 1;
  }
  const result = await orgs
    .prepare(
      `${insert} SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
        WHERE EXISTS (SELECT 1 FROM registry_keys
            WHERE org = ?1 AND position = ?2 - 1 AND key_id = ?9)
          AND NOT EXISTS (SELECT 1 FROM registry_keys WHERE org = ?1 AND position >= ?2)
        ON CONFLICT DO NOTHING`,
    )
    .bind(...values, write.previous ?? "")
    .run();
  return result.meta.changes === 1;
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
        VALUES (?1, ?2, ?3, ?2, 'unlisted', ?4) ON CONFLICT DO NOTHING`,
    )
    .bind(input.type, input.name, input.publisher, orgAudience(input.org))
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
    return results.map((row) => ({
      type,
      name: row.name,
      title: row.title.slice(0, 120),
      ...(row.latest ? { latest: row.latest } : {}),
    }));
  });
}
