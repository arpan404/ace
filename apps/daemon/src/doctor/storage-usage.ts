import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Check } from "@ace/diagnostics";
import type { DoctorContext } from "./feature.ts";
import { clip, formatBytes, plural } from "./format.ts";
import { logCap, readDataFolder, type DatabaseFile } from "./storage-folder.ts";
import { measureFolder, type FolderSize, type WalkBudget } from "./storage-walk.ts";

/** How far `storage.usage` may walk before it reports lower bounds. */
export type WalkLimits = { maxEntries: number; maxMs: number };
export const DEFAULT_WALK_LIMITS: WalkLimits = { maxEntries: 250_000, maxMs: 10_000 };

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
/** Rotation keeps logs at their cap; well past it means rotation isn't running. */
const LOG_SLACK = 1.25;
/** The main database's WAL has its own check (`sqlite.wal`); this bounds the others. */
const LARGE_WAL = GIB;
const SHOWN = 4;

const FIX =
  "Run ace clean --dry-run to see which old threads, worktrees and caches can go. ace config set log-cap SIZE changes the log cap.";

function sized(size: FolderSize): string {
  if (!size.complete && size.entries === 0) return "not measured";
  return size.complete ? formatBytes(size.bytes) : `at least ${formatBytes(size.bytes)}`;
}

function databaseLine(databases: readonly DatabaseFile[]): string {
  if (!databases.length) return "No databases yet.";
  const total = databases.reduce((sum, db) => sum + db.bytes + db.walBytes, 0);
  const shown = databases
    .slice(0, SHOWN)
    .map(
      (db) =>
        `${db.name} ${formatBytes(db.bytes)}${db.walBytes ? ` (WAL ${formatBytes(db.walBytes)})` : ""}`,
    );
  const rest = databases.slice(SHOWN);
  const restBytes = rest.reduce((sum, db) => sum + db.bytes + db.walBytes, 0);
  if (rest.length) shown.push(`${plural(rest.length, "smaller one")} ${formatBytes(restBytes)}`);
  return `Databases ${formatBytes(total)}: ${shown.join(", ")}.`;
}

function folderLine(folders: readonly { name: string; size: FolderSize }[]): string | undefined {
  if (!folders.length) return undefined;
  const largest = folders.toSorted((a, b) => b.size.bytes - a.size.bytes);
  const shown = largest.slice(0, SHOWN + 1).map((folder) => `${folder.name} ${sized(folder.size)}`);
  const rest = largest.slice(SHOWN + 1);
  if (rest.length)
    shown.push(
      `${plural(rest.length, "smaller one")} ${formatBytes(rest.reduce((sum, folder) => sum + folder.size.bytes, 0))}`,
    );
  return `Other folders: ${shown.join(", ")}.`;
}

/**
 * What the data folder holds: each database with its WAL, logs against their cap, worktrees,
 * and the other large folders. Folder walks share one bounded budget, so a huge worktrees
 * folder ends in "at least" instead of a hang.
 */
export function usageCheck(context: DoctorContext, limits: WalkLimits): Check {
  const dataDir = context.config.dataDir;
  return {
    id: "storage.usage",
    fix: FIX,
    // The walk's own limit plus room for the database stats and the settings read.
    timeoutMs: limits.maxMs + 10_000,
    async run(signal) {
      const folder = await readDataFolder(dataDir);
      const cap = await logCap(context);
      const budget: WalkBudget = {
        entries: limits.maxEntries,
        deadline: context.now() + limits.maxMs,
        now: context.now,
        signal,
      };
      const has = (name: string) => folder.folders.includes(name);
      const logs = has("logs") ? await measureFolder(join(dataDir, "logs"), budget) : undefined;
      const others: { name: string; size: FolderSize }[] = [];
      for (const name of folder.folders.filter(
        (other) => other !== "logs" && other !== "worktrees",
      ))
        others.push({ name, size: await measureFolder(join(dataDir, name), budget) });
      // Worktrees go last: they're the likeliest to be huge, and their count is cheap anyway.
      const worktrees = has("worktrees")
        ? {
            count: (await readdir(join(dataDir, "worktrees")).catch(() => [])).length,
            size: await measureFolder(join(dataDir, "worktrees"), budget),
          }
        : undefined;

      const problems: string[] = [];
      if (logs && logs.bytes > cap * LOG_SLACK + MIB)
        problems.push(
          `Logs use ${sized(logs)}, over their ${formatBytes(cap)} cap: old log files aren't being removed.`,
        );
      for (const db of folder.databases)
        if (db.name !== "events.sqlite" && db.walBytes >= LARGE_WAL)
          problems.push(
            `${db.name}'s WAL is ${formatBytes(db.walBytes)}: its changes aren't being folded back into the database.`,
          );

      const lines = [
        ...problems,
        databaseLine(folder.databases),
        logs ? `Logs ${sized(logs)} of a ${formatBytes(cap)} cap.` : "No logs yet.",
        worktrees
          ? `Worktrees: ${plural(worktrees.count, "folder")}, ${sized(worktrees.size)}.`
          : undefined,
        folderLine(others),
        folder.otherFileBytes ? `Other files ${formatBytes(folder.otherFileBytes)}.` : undefined,
      ].filter((line) => line !== undefined);
      return { status: problems.length ? "warn" : "ok", message: clip(lines.join(" ")), fix: FIX };
    },
  };
}
