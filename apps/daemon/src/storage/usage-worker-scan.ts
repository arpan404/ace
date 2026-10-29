import { realpathSync } from "node:fs";
import { join, relative, sep, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import { DatabaseSync } from "@ace/provider-kit/sqlite";
import { PinnedDirectory } from "@ace/workspace/pinned-directory";
import { readSqlitePageSpace } from "@ace/diagnostics";
import { StorageKind, StorageUsage, ThreadId } from "@ace/protocol";
import { builtinSkillSessionsDirectory, isBuiltinSkillRootName } from "../builtin-skill-roots.ts";
import { descriptorNames } from "@ace/workspace/descriptor";
import { transcriptBytes, transcriptQueries } from "./transcript.ts";
import { storageFileRoots } from "./usage-walk-roots.ts";
import { UsageWalk, missingUsagePath, type UsageBudget } from "./usage-walk.ts";
import type { UsageWorkerInput } from "./usage-worker-wire.ts";

const ThreadRow = z.object({ id: ThreadId });
const WorktreeRow = z.object({ path: z.string(), record: z.string() });
const WorktreeRecord = z.object({
  path: z.string(),
  parent_dev: z.number(),
  parent_ino: z.number(),
  tree_dev: z.number(),
  tree_ino: z.number(),
});

/** Called only in the isolate. Clock access and SQLite connection ownership live here. */
export async function scanUsage(
  input: z.infer<typeof UsageWorkerInput>,
  signal: AbortSignal,
): Promise<StorageUsage> {
  const started = performance.now();
  const budget: UsageBudget = {
    remaining: input.limits.maxEntries,
    deadline: started + input.limits.maxMs,
    maxDepth: input.limits.maxDepth,
    now: () => performance.now(),
    cancelled: () => signal.aborted,
  };
  const walk = new UsageWalk(budget);
  const usage: StorageUsage = {
    categories: StorageKind.options.map((kind) => ({ kind, bytes: 0, items: 0 })),
    databaseBytes: 0,
    reclaimableDatabaseBytes: 0,
    measuredAt: 0,
    complete: true,
    backups: [],
  };
  const category = (kind: StorageKind) => {
    const result = usage.categories.find((entry) => entry.kind === kind);
    if (!result) throw new Error("storage_usage_category");
    return result;
  };
  const root = PinnedDirectory.atBoundary(input.root);
  let db: DatabaseSync | undefined;
  const measure = async (path: string, kind: StorageKind, seen?: Set<string>) => {
    const size = await walk.measure(root, path, seen);
    const target = category(kind);
    target.bytes += size.bytes;
    target.items += size.items;
    usage.complete &&= size.complete;
    return size;
  };
  try {
    // Canonicalize only ancestors of the daemon home. Descendants stay descriptor-relative.
    const canonical = realpathSync(input.root);
    if (!root.matches(canonical)) throw new Error("storage_usage_root_changed");
    try {
      for (const name of [
        "events.sqlite",
        "events.sqlite-wal",
        "events.sqlite-shm",
        "events.sqlite-journal",
      ]) {
        try {
          const info = root.metadata(name);
          if ((info.mode & 0o170000) !== 0o100000) throw new Error("storage_usage_unsafe_database");
          if (name === "events.sqlite" || name === "events.sqlite-wal")
            usage.databaseBytes += info.size;
        } catch (error) {
          if (!missingUsagePath(error)) throw error;
        }
      }
      const before = root.fileMetadata("events.sqlite");
      db = new DatabaseSync(join(canonical, "events.sqlite"), { readOnly: true, timeout: 100 });
      const after = root.fileMetadata("events.sqlite");
      if (before.dev !== after.dev || before.ino !== after.ino || !root.matches(canonical))
        throw new Error("storage_usage_database_changed");
      usage.reclaimableDatabaseBytes = readSqlitePageSpace(db).reclaimableBytes;
    } catch {
      db?.close();
      db = undefined;
      usage.complete = false;
    }

    for (const [path, kind] of storageFileRoots) await measure(path, kind);
    // ContextService owns these two byte roots: committed blobs, including MIME aliases,
    // and pending upload files. Its SQLite metadata and reference counts aren't disk sizes.
    const attachmentFiles = new Set<string>();
    await measure("context/blobs", "attachments", attachmentFiles);
    await measure("context/uploads", "attachments", attachmentFiles);
    try {
      const sessions = root.child(builtinSkillSessionsDirectory);
      try {
        for (const name of descriptorNames(sessions.fd, Math.min(10_000, budget.remaining + 1))) {
          if (!(await walk.step())) {
            usage.complete = false;
            break;
          }
          if (!isBuiltinSkillRootName(name)) continue;
          const size = await walk.measure(root, `${builtinSkillSessionsDirectory}/${name}`);
          category("caches").bytes += size.bytes;
          category("caches").items++;
          usage.complete &&= size.complete;
        }
      } finally {
        sessions.closeSync();
      }
    } catch (error) {
      if (!missingUsagePath(error)) usage.complete = false;
    }

    if (db) {
      const connection = db;
      const has = (table: string) =>
        Boolean(
          connection
            .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
            .get(table),
        );
      try {
        const queries = transcriptQueries(connection);
        const purged = has("storage_purged")
          ? "AND NOT EXISTS(SELECT 1 FROM storage_purged p WHERE p.thread_id=threads.id)"
          : "";
        let cursor = "";
        const page = connection.prepare(
          `SELECT id FROM threads WHERE id>? ${purged} ORDER BY id LIMIT 128`,
        );
        while (true) {
          if (!(await walk.step())) {
            usage.complete = false;
            break;
          }
          const rows = z.array(ThreadRow).parse(page.all(cursor));
          if (!rows.length) break;
          for (const row of rows) {
            if (!(await walk.step())) {
              usage.complete = false;
              break;
            }
            const bytes = await transcriptBytes(
              (sql) => connection.prepare(sql),
              row.id,
              queries,
              () => walk.going(),
            );
            if (bytes === undefined) {
              usage.complete = false;
              break;
            }
            category("threads").bytes += bytes;
            category("threads").items++;
          }
          if (!walk.going() || budget.remaining <= 0) {
            usage.complete = false;
            break;
          }
          cursor = rows.at(-1)?.id ?? cursor;
          await setTimeout(1);
        }
      } catch {
        usage.complete = false;
      }
      try {
        if (has("managed_worktrees")) {
          let cursor = "";
          const seen = new Set<string>();
          const page = connection.prepare(
            "SELECT path,record FROM managed_worktrees WHERE removed=0 AND path>? ORDER BY path LIMIT 128",
          );
          while (true) {
            if (!(await walk.step())) {
              usage.complete = false;
              break;
            }
            const rows = z.array(WorktreeRow).parse(page.all(cursor));
            if (!rows.length) break;
            for (const row of rows) {
              if (!(await walk.step())) {
                usage.complete = false;
                break;
              }
              try {
                const record = WorktreeRecord.parse(JSON.parse(row.record));
                const name = relative(join(canonical, "worktrees"), record.path);
                if (
                  row.path !== record.path ||
                  !name ||
                  name === ".." ||
                  name.includes(sep) ||
                  resolve(record.path) !== join(canonical, "worktrees", name)
                )
                  throw new Error("storage_usage_unmanaged_path");
                const key = process.platform === "win32" ? name.toLowerCase() : name;
                if (seen.has(key)) continue;
                seen.add(key);
                const parent = root.child("worktrees");
                try {
                  const info = parent.stat();
                  if (info.dev !== record.parent_dev || info.ino !== record.parent_ino)
                    throw new Error("storage_usage_worktrees_changed");
                  try {
                    const tree = parent.child(name);
                    try {
                      const treeInfo = tree.stat();
                      if (treeInfo.dev !== record.tree_dev || treeInfo.ino !== record.tree_ino)
                        throw new Error("storage_usage_worktree_changed");
                    } finally {
                      tree.closeSync();
                    }
                    const size = await walk.measure(root, `worktrees/${name}`);
                    category("worktrees").bytes += size.bytes;
                    usage.complete &&= size.complete;
                  } catch (error) {
                    if (!missingUsagePath(error)) throw error;
                  }
                  category("worktrees").items++;
                } finally {
                  parent.closeSync();
                }
              } catch {
                usage.complete = false;
              }
            }
            if (!walk.going() || budget.remaining <= 0) {
              usage.complete = false;
              break;
            }
            cursor = rows.at(-1)?.path ?? cursor;
            await setTimeout(1);
          }
        }
        if (has("storage_worktree_backups") && has("managed_worktrees")) {
          usage.backups = connection
            .prepare(
              "SELECT b.result FROM storage_worktree_backups b JOIN managed_worktrees m ON m.path=b.path WHERE m.removed=0 ORDER BY (json_extract(b.result,'$.state')='failed') DESC,b.path LIMIT 256",
            )
            .all()
            .map((row) =>
              StorageUsage.shape.backups
                .unwrap()
                .element.parse(JSON.parse(z.string().parse(row.result))),
            );
        }
      } catch {
        usage.complete = false;
      }
    }
    usage.complete &&= walk.going() && budget.remaining > 0;
    usage.measuredAt = Date.now();
    return StorageUsage.parse(usage);
  } finally {
    try {
      db?.close();
    } finally {
      root.closeSync();
    }
  }
}
