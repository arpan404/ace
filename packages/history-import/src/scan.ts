import { scanCodexTitles } from "./codex-titles.ts";
import { setImmediate } from "node:timers/promises";
import { join } from "node:path";
import { lstat } from "node:fs/promises";
import { databaseFingerprint } from "./fingerprints.ts";
import { walkFiles, RECORD_LIMIT } from "@ace/native-session";
import { dbSessions, openProviderDb } from "./provider-db.ts";
import { SnapshotBusy } from "./snapshot-scratch.ts";
import { SnapshotChanged } from "./sqlite-snapshot.ts";
import type { ProviderHome } from "./contracts.ts";
import type { Catalog } from "./catalog.ts";
import { inventoryRoots } from "./scan-paths.ts";
import { ByteBudget } from "./byte-budget.ts";
import {
  sampleFile,
  unsupported,
  type CatalogWrite,
  type SampleContext,
  type ScanTally,
} from "./sample-file.ts";

/**
 * Bytes of file samples decoded at once across one provider's inventory. Parsed JSON can be
 * an order of magnitude larger than its text, and the worker heap is capped at 128 MiB.
 */
const DECODE_BUDGET = 2 * 1024 * 1024;

export async function scan(
  catalog: Catalog,
  instances: ProviderHome[],
  signal: AbortSignal,
  progress: (files: number, result: ScanTally) => void | Promise<void> = () => undefined,
) {
  const result: ScanTally = {
    files: 0,
    reads: 0,
    bytes: 0,
    skipped: 0,
    unsupported: [],
  };
  await catalog.cleanup(signal);
  for (const instance of instances) {
    signal.throwIfAborted();
    if (instance.provider === "cursor") {
      unsupported(
        result,
        instance.id,
        "Cursor transcripts omit tool outputs; TUI chats cannot be loaded through ACP",
      );
      continue;
    }
    const epoch = catalog.start(instance.id);
    const readsBefore = result.reads;
    {
      const roots = inventoryRoots(instance);
      const budget = { entries: 0 };
      const decode = new ByteBudget(DECODE_BUDGET);
      const largeRecords = new ByteBudget(RECORD_LIMIT);
      let batch: string[] = [];
      const context: SampleContext = {
        catalog,
        instance,
        epoch,
        signal,
        result,
        budget: decode,
        largeRecords,
        report: async () => {
          await progress(result.files, { ...result });
          await setImmediate();
        },
      };
      const flush = async () => {
        const writes: CatalogWrite[] = [];
        // Suspects from a crashed scan are read on their own, so another crash names its cause.
        const alone = batch.filter(
          (path) => catalog.crashes.verdict(instance.id, path).kind === "isolate",
        );
        const together = batch.filter((path) => !alone.includes(path));
        for (let offset = 0; offset < together.length; offset += 16) {
          const sampled = await Promise.allSettled(
            together.slice(offset, offset + 16).map((path) => sampleFile(context, path)),
          );
          for (const outcome of sampled) {
            if (outcome.status === "rejected") throw outcome.reason;
            if (outcome.value) writes.push(outcome.value);
          }
        }
        for (const path of alone) {
          const write = await sampleFile(context, path);
          if (write) writes.push(write);
        }
        signal.throwIfAborted();
        catalog.db.exec("BEGIN IMMEDIATE");
        try {
          for (const write of writes) write();
          catalog.db.exec("COMMIT");
        } catch (error) {
          catalog.db.exec("ROLLBACK");
          throw error;
        }
        batch = [];
        await setImmediate();
        signal.throwIfAborted();
      };
      for (const root of roots)
        for await (const path of walkFiles(root, signal, budget)) {
          batch.push(path);
          if (batch.length === 64) await flush();
        }
      if (batch.length) await flush();
      // Only recognized database names in the home root are opened. No auth/config files.
      for await (const path of rootDatabases(instance, signal)) {
        result.files++;
        let fp;
        try {
          fp = await databaseFingerprint(path);
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
          throw error;
        }
        if (catalog.touch(instance.id, path, fp, epoch)) {
          result.skipped++;
          continue;
        }
        const waiting = catalog.backoff.waiting(instance.id, path);
        if (waiting !== undefined) {
          // A recent failure keeps the last good rows and its notice. Later provider writes or
          // a full scan after the backoff read it again; polling would only spin the scheduler.
          catalog.preservePath(instance.id, path, epoch);
          result.skipped++;
          if (waiting && result.unsupported.length < 256)
            result.unsupported.push({ instanceId: instance.id, reason: waiting });
          continue;
        }
        const verdict = catalog.crashes.verdict(instance.id, path);
        if (verdict.kind === "blocked") {
          catalog.preservePath(instance.id, path, epoch);
          result.skipped++;
          unsupported(result, instance.id, verdict.reason);
          continue;
        }
        // Marked outside the savepoint: a crash must leave the mark durable.
        catalog.crashes.reading(instance.id, path);
        let db;
        catalog.db.exec("SAVEPOINT provider_scan");
        try {
          db = await openProviderDb(instance, path, catalog.snapshots, signal);
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
          await db.verify();
          // The rows read are one committed state even if the live provider has committed again.
          // Remember the original fingerprint so its newer data is picked up next scan.
          const info = await lstat(path);
          catalog.remember(instance, path, info.size, info.mtimeMs, fp, epoch);
          catalog.backoff.succeeded(instance.id, path);
          catalog.db.exec("RELEASE provider_scan");
        } catch (error) {
          catalog.db.exec("ROLLBACK TO provider_scan; RELEASE provider_scan");
          catalog.preservePath(instance.id, path, epoch);
          if (signal.aborted) throw error;
          // A busy snapshot is read by the next scan the person asks for.
          if (!(error instanceof SnapshotBusy)) {
            // Races, refusals and unreadable schemas all wait before the next attempt. A race
            // is not a notice: an active writer keeps producing changes that rescan it.
            const reason =
              error instanceof SnapshotChanged
                ? undefined
                : error instanceof Error
                  ? error.message
                  : "Unreadable provider database";
            catalog.backoff.failed(instance.id, path, reason);
            if (reason && result.unsupported.length < 256)
              result.unsupported.push({ instanceId: instance.id, reason });
          }
        } finally {
          await db?.close();
          catalog.crashes.finished(instance.id, path);
        }
      }
      if (instance.provider === "codex") await scanCodexTitles(catalog, instance, epoch, signal);
      signal.throwIfAborted();
      const removed = await catalog.prune(instance.id, epoch, signal);
      // A repeated scan in the same session already has recency for unchanged sources.
      if (removed || result.reads !== readsBefore)
        await catalog.summarizeTree(instance.id, signal, () =>
          progress(result.files, { ...result }),
        );
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
