import { pathToFileURL } from "node:url";
import { DatabaseSync } from "@ace/provider-kit/sqlite";
import { lstat, mkdtemp, rm, chmod } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import { safeOpen, fingerprint, object, string, timestamp } from "@ace/native-session";
import { HistorySession } from "@ace/protocol/history";
import type { ProviderHome } from "./contracts.ts";
import { sourceId } from "./metadata.ts";

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
/** SQLite readOnly still updates WAL read marks in the source -shm file.
 * Live homes therefore need a bounded private snapshot, never a source SQLite handle. */
export async function openProviderDb(
  instance: ProviderHome,
  path: string,
  scratchRoot: string,
  signal: AbortSignal,
) {
  const journal = await exists(`${path}-journal`);
  const wal = await exists(`${path}-wal`);
  if (instance.offlineSnapshot && (wal || journal))
    throw new Error("Immutable snapshot has a WAL or journal");
  if (journal)
    throw new Error("Provider has an active rollback journal; retry after its writer settles");
  if (instance.offlineSnapshot) {
    const file = await safeOpen(instance.homeDir, path);
    await file.close();
    const db = new DatabaseSync(`${pathToFileURL(path).href}?immutable=1`, { readOnly: true });
    return { db, close: async () => db.close() };
  }
  const stage = await mkdtemp(join(scratchRoot, "sqlite-read-"));
  const target = join(stage, "snapshot.sqlite");
  try {
    const sources = wal ? [path, path + "-wal"] : [path];
    const stamps: string[] = [];
    for (const [index, source] of sources.entries()) {
      signal.throwIfAborted();
      const file = await safeOpen(instance.homeDir, source);
      try {
        const before = await file.stat();
        stamps.push(fingerprint(before));
        await pipeline(
          file.createReadStream({
            autoClose: false,
            highWaterMark: 64 * 1024,
            start: 0,
            end: Math.max(0, before.size - 1),
          }),
          createWriteStream(index === 0 ? target : target + "-wal", { flags: "wx", mode: 0o600 }),
          { signal },
        );
        if (fingerprint(before) !== fingerprint(await file.stat()))
          throw new Error("Provider database changed during snapshot");
      } finally {
        await file.close();
      }
    }
    for (const [index, source] of sources.entries())
      if (fingerprint(await lstat(source)) !== stamps[index])
        throw new Error("Provider database changed during snapshot");
    if (wal !== (await exists(path + "-wal")) || (await exists(path + "-journal")))
      throw new Error("Provider journal changed during snapshot");
    await chmod(target, 0o600);
    const db = new DatabaseSync(target, { readOnly: true });
    return {
      db,
      close: async () => {
        db.close();
        await rm(stage, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}
export function columns(
  db: DatabaseSync,
  table: "session" | "threads" | "message" | "part" | "session_message",
): Set<string> {
  return new Set(
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((r) => String(r.name)),
  );
}
export function supportsOpenCode(db: DatabaseSync): boolean {
  return (
    ["id", "directory", "title", "time_updated"].every((c) => columns(db, "session").has(c)) &&
    ["id", "data", "session_id", "time_created"].every((c) => columns(db, "message").has(c)) &&
    ["id", "data", "message_id"].every((c) => columns(db, "part").has(c))
  );
}
export function* dbSessions(
  instance: ProviderHome,
  path: string,
  db: DatabaseSync,
): Generator<HistorySession> {
  if (instance.provider === "codex") {
    const cols = columns(db, "threads");
    if (!["id", "cwd", "title", "updated_at"].every((c) => cols.has(c)))
      throw new Error("Unknown Codex state database schema");
    if (
      Number(
        db
          .prepare(
            "SELECT EXISTS(SELECT 1 FROM threads WHERE octet_length(id)>1024 OR octet_length(cwd)>8192 OR octet_length(title)>65536) AS too_large",
          )
          .get()?.too_large,
      ) > 0
    )
      throw new Error("Codex session metadata exceeds supported limits");
    for (const row of db
      .prepare("SELECT id,cwd,title,updated_at FROM threads ORDER BY id")
      .iterate()) {
      yield HistorySession.parse({
        id: sourceId(instance.id, path, String(row.id)),
        instanceId: instance.id,
        provider: "codex",
        nativeId: row.id,
        cwd: row.cwd,
        title: String(row.title).slice(0, 256),
        lastActivity: Number(row.updated_at) * 1000,
        messageCount: 0,
        countAccuracy: "sampled",
        support: {
          status: "unsupported",
          reason: "Database-only Codex session requires provider history APIs",
        },
      });
    }
    return;
  }
  if (!supportsOpenCode(db)) throw new Error("Unknown OpenCode database schema");
  if (
    Number(
      db
        .prepare(
          "SELECT EXISTS(SELECT 1 FROM session WHERE octet_length(id)>1024 OR octet_length(directory)>8192 OR octet_length(title)>65536 OR octet_length(parent_id)>1024) OR EXISTS(SELECT 1 FROM message WHERE octet_length(id)>1024) OR EXISTS(SELECT 1 FROM part WHERE octet_length(id)>1024) AS too_large",
        )
        .get()?.too_large,
    ) > 0
  )
    throw new Error("OpenCode session metadata exceeds supported limits");
  const count = db.prepare("SELECT COUNT(*) AS n FROM message WHERE session_id = ?");
  const latest = db.prepare(
    "SELECT CASE WHEN octet_length(data)<=65536 THEN data ELSE NULL END AS data FROM message WHERE session_id = ? ORDER BY time_created DESC,id DESC LIMIT 32",
  );
  const v2 = columns(db, "session_message").has("session_id")
    ? db.prepare("SELECT COUNT(*) AS n FROM session_message WHERE session_id = ?")
    : undefined;
  const oversized = db.prepare(
    "SELECT EXISTS(SELECT 1 FROM message WHERE session_id=? AND octet_length(data)>1048576) OR EXISTS(SELECT 1 FROM part p JOIN message m ON m.id=p.message_id WHERE m.session_id=? AND octet_length(p.data)>1048576) AS too_large",
  );
  for (const row of db
    .prepare("SELECT id,directory,title,time_updated,parent_id FROM session ORDER BY id")
    .iterate()) {
    let model: string | undefined;
    for (const entry of latest.iterate(String(row.id))) {
      try {
        const m = object(JSON.parse(String(entry.data)));
        model = string(m.modelID) ?? string(object(m.model).modelID);
        if (model) break;
      } catch {
        /* unknown or oversized metadata remains unguessed */
      }
    }
    const v2History = Number(v2?.get(String(row.id))?.n ?? 0) > 0;
    const largeRecord = Number(oversized.get(String(row.id), String(row.id))?.too_large ?? 0) > 0;
    const unsupported = v2History || largeRecord;
    yield HistorySession.parse({
      id: sourceId(instance.id, path, String(row.id)),
      instanceId: instance.id,
      provider: "opencode",
      nativeId: row.id,
      cwd: row.directory,
      title: String(row.title).slice(0, 256),
      lastActivity: timestamp(row.time_updated) ?? 0,
      messageCount: Number(count.get(String(row.id))?.n ?? 0),
      countAccuracy: "exact",
      ...(model ? { model: model.slice(0, 512) } : {}),
      ...(row.parent_id ? { parentNativeId: row.parent_id } : {}),
      support: unsupported
        ? {
            status: "unsupported",
            reason: v2History
              ? "OpenCode v2 session_message history is not mapped yet"
              : "OpenCode SQLite record exceeds the bounded decoder limit; use native export",
          }
        : { status: "supported" },
    });
  }
}
