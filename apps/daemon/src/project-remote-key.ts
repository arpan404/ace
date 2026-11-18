import type { DatabaseSync } from "node:sqlite";
import { ProjectRemoteKey, WorkspaceId } from "@ace/protocol";

/*
 * Each registration's remote key (ADR 0189): its remotes and folder inside the repository, as
 * last read from Git, kept beside the registration so a list reports it without reading Git.
 * Opening the daemon only makes the table, empty the first time (ADR 0170); rows are filled in
 * idle batches (`RemoteKeyReader`). `apart` records an unlink: that registration's key is never
 * reported again, so clients never group it by remote. It outlives every later read.
 */

export function migrateRemoteKeys(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS workspace_remote_key (
    workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id), remotes TEXT, subpath TEXT,
    read_at INTEGER, apart INTEGER NOT NULL DEFAULT 0
  );`);
}

/** The columns `decodeRemoteKey` reads, joined on `rk` (`workspace_remote_key`). */
export const remoteKeyColumns =
  "rk.remotes AS remoteKeyRemotes,rk.subpath AS remoteKeySubpath,rk.apart AS remoteKeyApart";
export const remoteKeyJoin = "LEFT JOIN workspace_remote_key rk ON rk.workspace_id=w.id";

/** A registration's reported key; undefined when unread, without a remote, or kept apart. */
export function decodeRemoteKey(row: {
  remoteKeyRemotes?: unknown;
  remoteKeySubpath?: unknown;
  remoteKeyApart?: unknown;
}): ProjectRemoteKey | undefined {
  if (row.remoteKeyApart === 1 || typeof row.remoteKeyRemotes !== "string") return undefined;
  try {
    const parsed = ProjectRemoteKey.safeParse({
      remotes: JSON.parse(row.remoteKeyRemotes),
      subpath: row.remoteKeySubpath,
    });
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Never group this registration by remote again: the person unlinked it. */
export function keepApart(db: DatabaseSync, workspaceId: WorkspaceId): void {
  db.prepare(
    `INSERT INTO workspace_remote_key(workspace_id,apart) VALUES (?,1)
    ON CONFLICT(workspace_id) DO UPDATE SET apart=1`,
  ).run(workspaceId);
}

/** A registration whose key is due a read, with the key it holds now. */
export interface DueRead {
  workspaceId: WorkspaceId;
  path: string;
  /** The stored key as text (`remotes` JSON and subpath), to tell whether a read changed it. */
  before: string | null;
  apart: boolean;
}

/**
 * Up to `limit` registered, ordinary projects whose key was never read or was read before
 * `staleBefore`, never read first. Bounded by `limit`, not by how many projects there are.
 */
export function dueReads(db: DatabaseSync, staleBefore: number, limit: number): DueRead[] {
  return db
    .prepare(
      `SELECT w.id,w.path,rk.remotes,rk.subpath,rk.apart FROM workspaces w
      LEFT JOIN workspace_metadata m ON m.workspace_id=w.id ${remoteKeyJoin}
      WHERE NOT EXISTS (SELECT 1 FROM workspace_unregistered WHERE workspace_id=w.id)
      AND m.kind IS NULL AND (rk.read_at IS NULL OR rk.read_at<?)
      ORDER BY rk.read_at IS NOT NULL,rk.read_at,w.id LIMIT ?`,
    )
    .all(staleBefore, limit)
    .map((row) => ({
      workspaceId: WorkspaceId.parse(row.id),
      path: String(row.path),
      before: keyText(row.remotes, row.subpath),
      apart: row.apart === 1,
    }));
}

const keyText = (remotes: unknown, subpath: unknown) =>
  typeof remotes === "string" ? `${remotes}\n${String(subpath ?? "")}` : null;

/**
 * Keep what a read found at `at`: `remotes` empty for a folder outside Git or without a
 * remote. Whether the stored key changed, so the caller tells clients.
 */
export function saveRead(
  db: DatabaseSync,
  due: DueRead,
  found: { remotes: readonly string[]; subpath: string },
  at: number,
): boolean {
  const remotes = found.remotes.length ? JSON.stringify([...found.remotes].toSorted()) : null;
  const subpath = remotes === null ? null : found.subpath;
  db.prepare(
    `INSERT INTO workspace_remote_key(workspace_id,remotes,subpath,read_at) VALUES (?,?,?,?)
    ON CONFLICT(workspace_id) DO UPDATE SET remotes=excluded.remotes,subpath=excluded.subpath,
    read_at=excluded.read_at`,
  ).run(due.workspaceId, remotes, subpath, at);
  return keyText(remotes, subpath) !== due.before;
}

/** A read that failed waits as long as one that worked: Git is asked again once it is stale. */
export function markRead(db: DatabaseSync, workspaceId: WorkspaceId, at: number): void {
  db.prepare(
    `INSERT INTO workspace_remote_key(workspace_id,read_at) VALUES (?,?)
    ON CONFLICT(workspace_id) DO UPDATE SET read_at=excluded.read_at`,
  ).run(workspaceId, at);
}
