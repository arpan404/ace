import type { DatabaseSync } from "node:sqlite";
import {
  ProjectIdentity,
  ProjectIdentityId,
  maxIdentityAliases,
  type ProjectIdentitySource,
  type WorkspaceId,
} from "@ace/protocol";

/*
 * Logical project identity (ADR 0180), kept beside the registrations it groups. A registration
 * with no `workspace_identity` row is its own project: nothing is backfilled, and opening the
 * daemon only makes these tables, empty the first time (ADR 0170). Aliases are kept flat: a
 * merge into P re-points every alias that named the merged id, so P's aliases are one indexed
 * read, and a self-alias left by a merge back is dropped.
 */

export function migrateProjectIdentity(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS workspace_identity (
    workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id), identity_id TEXT NOT NULL,
    source TEXT NOT NULL, linked_at INTEGER NOT NULL
  ); CREATE INDEX IF NOT EXISTS workspace_identity_by_id ON workspace_identity(identity_id);
  CREATE TABLE IF NOT EXISTS identity_alias (
    from_id TEXT PRIMARY KEY, to_id TEXT NOT NULL, at INTEGER NOT NULL
  ); CREATE INDEX IF NOT EXISTS identity_alias_by_target ON identity_alias(to_id, at DESC);`);
}

/** The identity columns `decodeProjectRow` reads, joined on `wi` (`workspace_identity`). */
export const identityColumns = `wi.identity_id AS identityId,wi.source AS identitySource,
  (SELECT json_group_array(from_id) FROM (SELECT from_id FROM identity_alias
    WHERE to_id=wi.identity_id ORDER BY at DESC,from_id LIMIT ${maxIdentityAliases})) AS identityAliases`;
export const identityJoin = "LEFT JOIN workspace_identity wi ON wi.workspace_id=w.id";

/**
 * A stored row's identity, or undefined for a registration without one. These are rows this
 * daemon wrote (ADR 0125), but one that no longer reads as an identity is left out rather than
 * failing the whole project list.
 */
export function decodeIdentity(row: {
  identityId?: unknown;
  identitySource?: unknown;
  identityAliases?: unknown;
}): ProjectIdentity | undefined {
  if (typeof row.identityId !== "string") return undefined;
  let aliases: unknown = [];
  try {
    if (typeof row.identityAliases === "string") aliases = JSON.parse(row.identityAliases);
  } catch {
    aliases = [];
  }
  const parsed = ProjectIdentity.safeParse({
    id: row.identityId,
    source: row.identitySource,
    aliases: Array.isArray(aliases)
      ? aliases.filter(
          (alias) => alias !== row.identityId && ProjectIdentityId.safeParse(alias).success,
        )
      : [],
  });
  return parsed.success ? parsed.data : undefined;
}

/** Set one registration's identity, replacing any it had. */
export function setIdentity(
  db: DatabaseSync,
  workspaceId: WorkspaceId,
  identityId: ProjectIdentityId,
  source: ProjectIdentitySource,
  at: number,
): void {
  db.prepare(
    `INSERT INTO workspace_identity VALUES (?,?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET
    identity_id=excluded.identity_id,source=excluded.source,linked_at=excluded.linked_at`,
  ).run(workspaceId, identityId, source, at);
}

/** The registration's identity id, or undefined while it has none. */
export function identityOf(db: DatabaseSync, workspaceId: WorkspaceId): string | undefined {
  const row = db
    .prepare("SELECT identity_id FROM workspace_identity WHERE workspace_id=?")
    .get(workspaceId);
  return typeof row?.identity_id === "string" ? row.identity_id : undefined;
}

/** Registrations here whose identity is `identityId`. */
function holders(db: DatabaseSync, identityId: string): WorkspaceId[] {
  return db
    .prepare(
      "SELECT workspace_id FROM workspace_identity WHERE identity_id=? ORDER BY workspace_id",
    )
    .all(identityId)
    .map((row) => String(row.workspace_id) as WorkspaceId);
}

/**
 * Merge `from` into `into`, in the caller's transaction: every registration of `from` takes
 * `into`, aliases that named `from` name `into`, and `from` becomes an alias of `into`. Returns
 * the registrations whose reported identity changed: `from`'s, now `into`'s, and `into`'s own,
 * whose aliases grew. `from` equal to `into` changes nothing.
 */
export function mergeIdentity(
  db: DatabaseSync,
  from: ProjectIdentityId,
  into: ProjectIdentityId,
  at: number,
): WorkspaceId[] {
  // `into` merged on into another here already: that one is where `from` goes too.
  const target = db.prepare("SELECT to_id FROM identity_alias WHERE from_id=?").get(into)?.to_id;
  if (typeof target === "string" && ProjectIdentityId.safeParse(target).success)
    into = ProjectIdentityId.parse(target);
  if (from === into) return [];
  db.prepare(
    "UPDATE workspace_identity SET identity_id=?,source='linked',linked_at=? WHERE identity_id=?",
  ).run(into, at, from);
  db.prepare("UPDATE identity_alias SET to_id=? WHERE to_id=?").run(into, from);
  db.prepare("DELETE FROM identity_alias WHERE from_id=to_id").run();
  db.prepare(
    `INSERT INTO identity_alias VALUES (?,?,?) ON CONFLICT(from_id) DO UPDATE SET
    to_id=excluded.to_id,at=excluded.at`,
  ).run(from, into, at);
  return holders(db, into);
}

/** A logical project as a transfer carries it: its id and the aliases its machine keeps. */
export interface CarriedIdentity {
  id: ProjectIdentityId;
  aliases: ProjectIdentityId[];
}

/** The ids that name `identity`'s logical project: its own and its aliases. */
const namesOf = (identity: CarriedIdentity) => [...new Set([identity.id, ...identity.aliases])];

/**
 * Registrations here in `identity`'s logical project, most recently used first: one whose
 * identity is any of its names, or merged here into one of them. One whose identity came from a
 * project marker is never one: a marker is repository data anyone can copy (ADR 0180).
 */
export function registrationsOf(
  db: DatabaseSync,
  identity: CarriedIdentity,
): { workspaceId: WorkspaceId; path: string }[] {
  const names = namesOf(identity);
  const marks = names.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT w.id,w.path FROM workspace_identity wi JOIN workspaces w ON w.id=wi.workspace_id
      LEFT JOIN workspace_metadata m ON m.workspace_id=w.id
      LEFT JOIN workspace_recent r ON r.workspace_id=w.id
      WHERE (wi.identity_id IN (${marks})
        OR wi.identity_id IN (SELECT to_id FROM identity_alias WHERE from_id IN (${marks})))
      AND wi.source<>'marker' AND m.kind IS NULL
      AND NOT EXISTS (SELECT 1 FROM workspace_unregistered u WHERE u.workspace_id=w.id)
      ORDER BY r.opened_at IS NULL,r.opened_at DESC,w.id`,
    )
    .all(...names, ...names)
    .map((row) => ({ workspaceId: String(row.id) as WorkspaceId, path: String(row.path) }));
}

/** Whether `identityId` here is in `identity`'s logical project. */
export function inGroup(db: DatabaseSync, identityId: string, identity: CarriedIdentity): boolean {
  const names = namesOf(identity);
  if (names.includes(identityId as ProjectIdentityId)) return true;
  const marks = names.map(() => "?").join(",");
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM identity_alias WHERE (from_id IN (${marks}) AND to_id=?)
        OR (from_id=? AND to_id IN (${marks})) LIMIT 1`,
      )
      .get(...names, identityId, identityId, ...names),
  );
}

/** Keep a paired machine's aliases of `into` here, without changing any alias already kept. */
export function keepAliases(db: DatabaseSync, identity: CarriedIdentity, at: number): void {
  for (const alias of identity.aliases)
    if (alias !== identity.id)
      db.prepare("INSERT INTO identity_alias VALUES (?,?,?) ON CONFLICT(from_id) DO NOTHING").run(
        alias,
        identity.id,
        at,
      );
}
