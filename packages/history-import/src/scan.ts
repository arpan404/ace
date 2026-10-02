import { setImmediate } from "node:timers/promises";
import { basename, join } from "node:path";
import { lstat } from "node:fs/promises";
import { databaseFingerprint, storageFingerprint } from "./fingerprints.ts";
import {
  walkFiles,
  readHeadTail,
  fingerprint,
  object,
  string,
  timestamp,
  claudeSidechainParent,
} from "@ace/native-session";
import { HistorySession } from "@ace/protocol/history";
import { summary, sourceId } from "./metadata.ts";
import { dbSessions, openProviderDb } from "./provider-db.ts";
import type { ProviderHome } from "./contracts.ts";
import type { Catalog } from "./catalog.ts";

export async function scan(
  catalog: Catalog,
  instances: ProviderHome[],
  signal: AbortSignal,
  progress: (files: number) => void = () => undefined,
) {
  const result = {
    files: 0,
    reads: 0,
    bytes: 0,
    skipped: 0,
    unsupported: [] as { instanceId: string; reason: string }[],
  };
  for (const instance of instances) {
    signal.throwIfAborted();
    if (instance.provider === "cursor") {
      result.unsupported.push({
        instanceId: instance.id,
        reason: "Cursor transcripts omit tool outputs; TUI chats cannot be loaded through ACP",
      });
      continue;
    }
    const epoch = catalog.start(instance.id);
    catalog.db.exec("BEGIN IMMEDIATE");
    try {
      const roots =
        instance.provider === "claude"
          ? [join(instance.homeDir, "projects")]
          : instance.provider === "codex"
            ? [join(instance.homeDir, "sessions"), join(instance.homeDir, "archived_sessions")]
            : [join(instance.homeDir, "storage/session")];
      const budget = { entries: 0 };
      let batch: string[] = [];
      const processFile = async (path: string) => {
        const isStorage = instance.provider === "opencode";
        if (!path.endsWith(isStorage ? ".json" : ".jsonl")) {
          if (
            path.endsWith(".zst") &&
            !result.unsupported.some((r) => r.instanceId === instance.id)
          )
            result.unsupported.push({
              instanceId: instance.id,
              reason: "Compressed Codex rollouts require provider-owned materialization",
            });
          return;
        }
        result.files++;
        if (result.files % 64 === 0) {
          progress(result.files);
          await setImmediate();
          signal.throwIfAborted();
        }
        const fp = isStorage
          ? await storageFingerprint(instance, path, signal)
          : fingerprint(await lstat(path));
        if (catalog.touch(instance.id, path, fp, epoch)) {
          result.skipped++;
          return;
        }
        const sample = await readHeadTail(instance.homeDir, path, signal);
        result.reads++;
        result.bytes += sample.bytes;
        let s = summary(instance, path, sample.records, sample.exact, sample.mtime);
        if (isStorage) {
          const r = object(sample.records[0]);
          const time = object(r.time);
          const nativeId = string(r.id) ?? basename(path, ".json");
          s = HistorySession.parse({
            ...s,
            id: sourceId(instance.id, path, nativeId),
            nativeId,
            title: string(r.title) ?? nativeId,
            cwd: string(r.directory) ?? "",
            lastActivity: timestamp(time.updated) ?? sample.mtime,
            parentNativeId: string(r.parentID),
            countAccuracy: "sampled",
          });
        } else if (instance.provider === "claude" && claudeSidechainParent(path)) {
          const parent = claudeSidechainParent(path);
          s = HistorySession.parse({
            ...s,
            id: sourceId(instance.id, path, basename(path, ".jsonl")),
            nativeId: basename(path, ".jsonl"),
            parentNativeId: parent,
          });
        }
        if (!isStorage && fp !== sample.fingerprint)
          throw new Error("Session changed before sampling");
        catalog.put(
          {
            summary: s,
            path,
            fingerprint: fp,
            kind: isStorage ? "storage" : "jsonl",
            instanceId: instance.id,
          },
          epoch,
        );
      };
      const flush = async () => {
        const results = await Promise.allSettled(batch.map(processFile));
        batch = [];
        for (const outcome of results) if (outcome.status === "rejected") throw outcome.reason;
      };
      for (const root of roots)
        for await (const path of walkFiles(root, signal, budget)) {
          batch.push(path);
          if (batch.length === 16) await flush();
        }
      if (batch.length) await flush();
      // Only recognized database names in the home root are opened. No auth/config files.
      for await (const path of rootDatabases(instance, signal)) {
        result.files++;
        const fp = await databaseFingerprint(path);
        if (catalog.touch(instance.id, path, fp, epoch)) {
          result.skipped++;
          continue;
        }
        let db;
        catalog.db.exec("SAVEPOINT provider_scan");
        try {
          db = await openProviderDb(instance, path, catalog.scratchRoot, signal);
          result.reads++;
          let rows = 0;
          for (const s of dbSessions(instance, path, db.db)) {
            if (++rows > 100000)
              throw new Error("Provider database session inventory limit exceeded");
            if (rows % 64 === 0) {
              progress(result.files);
              await setImmediate();
            }
            signal.throwIfAborted();
            if (instance.provider === "codex" && catalog.hasNative(instance.id, s.nativeId))
              continue;
            catalog.put(
              { summary: s, path, fingerprint: fp, kind: "database", instanceId: instance.id },
              epoch,
            );
          }
          if (fp !== (await databaseFingerprint(path)))
            throw new Error("Provider database changed during scan");
          catalog.db.exec("RELEASE provider_scan");
        } catch (error) {
          catalog.db.exec("ROLLBACK TO provider_scan; RELEASE provider_scan");
          catalog.preservePath(instance.id, path, epoch);
          if (signal.aborted) throw error;
          if (result.unsupported.length < 256)
            result.unsupported.push({
              instanceId: instance.id,
              reason: error instanceof Error ? error.message : "Unreadable provider database",
            });
        } finally {
          await db?.close();
        }
      }
      signal.throwIfAborted();
      catalog.prune(instance.id, epoch);
      catalog.summarizeTree(instance.id);
    } finally {
      catalog.db.exec("COMMIT");
    }
  }
  return result;
}
async function* rootDatabases(instance: ProviderHome, signal: AbortSignal) {
  if (instance.provider !== "codex" && instance.provider !== "opencode") return;
  // walkFiles has a depth cap; filter depth here to never open nested databases.
  const { opendir } = await import("node:fs/promises");
  let dir;
  try {
    dir = await opendir(instance.homeDir);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  for await (const entry of dir) {
    signal.throwIfAborted();
    const match =
      instance.provider === "codex" ? /^state_\d+\.sqlite$/ : /^opencode(?:-[\w-]+)?\.db$/;
    if (entry.isFile() && match.test(entry.name)) yield join(instance.homeDir, entry.name);
  }
}
