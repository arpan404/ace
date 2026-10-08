import { scanCodexTitles } from "./codex-titles.ts";
import { sourceRecords } from "./source-records.ts";
import { sessionTitle, userPrompt, hasUserInput } from "./user-text.ts";
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
import type { InventoryChanges } from "./inventory-watch.ts";
import { inventoryRoots, changedRoots, changedFiles, isRootDatabase } from "./scan-paths.ts";

export async function scan(
  catalog: Catalog,
  instances: ProviderHome[],
  signal: AbortSignal,
  progress: (
    files: number,
    result: {
      files: number;
      reads: number;
      bytes: number;
      skipped: number;
      unsupported: { instanceId: string; reason: string }[];
    },
  ) => void | Promise<void> = () => undefined,
  changes?: InventoryChanges,
) {
  const result = {
    files: 0,
    reads: 0,
    bytes: 0,
    skipped: 0,
    unsupported: [] as { instanceId: string; reason: string }[],
  };
  await catalog.cleanup(signal);
  catalog.updates.begin();
  for (const instance of instances) {
    signal.throwIfAborted();
    if (instance.provider === "cursor") {
      if (result.unsupported.length < 256)
        result.unsupported.push({
          instanceId: instance.id,
          reason: "Cursor transcripts omit tool outputs; TUI chats cannot be loaded through ACP",
        });
      continue;
    }
    const changed =
      changes === undefined
        ? undefined
        : changedRoots(
            instance,
            changes.find((entry) => entry.instanceId === instance.id)?.paths ?? [],
          );
    if (changed?.length === 0) continue;
    const epoch = catalog.start(instance.id);
    const readsBefore = result.reads;
    {
      const roots =
        changed?.filter((path) => !isRootDatabase(instance, path)) ?? inventoryRoots(instance);
      if (changed) for (const path of changed) catalog.updates.path(instance.id, path);
      const budget = { entries: 0 };
      let batch: string[] = [];
      const processFile = async (path: string) => {
        const isStorage = instance.provider === "opencode";
        if (!path.endsWith(isStorage ? ".json" : ".jsonl")) {
          if (
            path.endsWith(".zst") &&
            result.unsupported.length < 256 &&
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
          await progress(result.files, { ...result });
          await setImmediate();
          signal.throwIfAborted();
        }
        const info = await lstat(path);
        const fp = isStorage ? await storageFingerprint(instance, path, signal) : fingerprint(info);
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
            title: sessionTitle(string(r.title) ?? "", "", timestamp(time.updated) ?? sample.mtime),
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
        let prompt = sample.records.map(userPrompt).find(Boolean) ?? "";
        let input = sample.records.some(hasUserInput);
        if (isStorage || !sample.exact) {
          if (!isStorage) result.reads++;
          for await (const record of sourceRecords(
            instance,
            {
              summary: s,
              path,
              fingerprint: fp,
              kind: isStorage ? "storage" : "jsonl",
              instanceId: instance.id,
              hidden: false,
            },
            signal,
            catalog.scratchRoot,
          )) {
            if (!isStorage) result.bytes += record.bytes;
            if ("value" in record) {
              prompt = userPrompt(record.value);
              input = hasUserInput(record.value);
            }
            if (input) break;
          }
          if (!isStorage)
            s = summary(instance, path, sample.records, sample.exact, sample.mtime, prompt);
          s = {
            ...s,
            title: sessionTitle(
              isStorage
                ? (string(object(sample.records[0]).title) ?? "")
                : s.title.startsWith("Session from ")
                  ? ""
                  : s.title,
              prompt,
              s.lastActivity,
            ),
          };
        }
        catalog.put(
          {
            summary: s,
            hidden: !input,
            path,
            fingerprint: fp,
            kind: isStorage ? "storage" : "jsonl",
            instanceId: instance.id,
          },
          epoch,
        );
        catalog.remember(instance, path, info.size, info.mtimeMs, fp, epoch);
      };
      const flush = async () => {
        catalog.db.exec("BEGIN IMMEDIATE");
        let results: PromiseSettledResult<void>[];
        try {
          results = await Promise.allSettled(batch.map(processFile));
        } finally {
          catalog.db.exec("COMMIT");
        }
        batch = [];
        await setImmediate();
        signal.throwIfAborted();
        for (const outcome of results) if (outcome.status === "rejected") throw outcome.reason;
      };
      for (const root of roots)
        for await (const path of changed === undefined
          ? walkFiles(root, signal, budget)
          : changedFiles(root, signal, budget)) {
          batch.push(path);
          if (batch.length === 4) await flush();
        }
      if (batch.length) await flush();
      // Only recognized database names in the home root are opened. No auth/config files.
      const databases =
        changed === undefined
          ? rootDatabases(instance, signal)
          : changed.filter((path) => isRootDatabase(instance, path));
      for await (const path of databases) {
        result.files++;
        let fp;
        try {
          fp = await databaseFingerprint(path);
        } catch (error) {
          if (changed && error instanceof Error && "code" in error && error.code === "ENOENT")
            continue;
          throw error;
        }
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
          for (const entry of dbSessions(instance, path, db.db)) {
            const s = entry.summary;

            if (++rows > 100000)
              throw new Error("Provider database session inventory limit exceeded");
            if (rows % 64 === 0) {
              await progress(result.files, { ...result });
              await setImmediate();
            }
            signal.throwIfAborted();
            catalog.put(
              {
                summary: s,
                hidden: entry.hidden,
                path,
                fingerprint: fp,
                kind: "database",
                instanceId: instance.id,
              },
              epoch,
            );
            if (instance.provider === "codex" && !s.title.startsWith("Session from "))
              catalog.setNativeTitle(instance.id, s.nativeId, s.title, "database");
          }
          // The private snapshot is consistent even if the live provider has committed again.
          // Remember the original fingerprint so its newer data is picked up next scan.
          const info = await lstat(path);
          catalog.remember(instance, path, info.size, info.mtimeMs, fp, epoch);
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
      if (instance.provider === "codex") await scanCodexTitles(catalog, instance, epoch, signal);
      signal.throwIfAborted();
      if (changed) {
        for (const path of changed) await catalog.updates.prune(instance.id, path, epoch, signal);
        await catalog.updates.summarize(instance.id, signal);
      } else {
        const removed = await catalog.prune(instance.id, epoch, signal);
        // The saved tree already has recency for unchanged sources. Avoid rewriting
        // every summary on warm startup, while still reconciling deletions.
        if (removed || result.reads !== readsBefore)
          await catalog.summarizeTree(instance.id, signal, () =>
            progress(result.files, { ...result }),
          );
      }
    }
  }
  await progress(result.files, { ...result });
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
