import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";

/** How much a set of folder walks may cost in total. Shared, so one huge folder can't take it all twice. */
export type WalkBudget = {
  /** Entries (files and folders) still allowed. */
  entries: number;
  /** When walking stops, on `now`'s clock. */
  deadline: number;
  now: () => number;
  signal: AbortSignal;
};

export type FolderSize = {
  bytes: number;
  /** Files and folders counted. */
  entries: number;
  /** False when the budget ran out first: `bytes` is then a lower bound. */
  complete: boolean;
};

const LSTAT_BATCH = 64;

function spent(budget: WalkBudget): boolean {
  return budget.entries <= 0 || budget.now() >= budget.deadline || budget.signal.aborted;
}

/**
 * Bytes under `path`, without following links, until the budget runs out. Unreadable or
 * vanished folders count as empty: the size is a hint, not a ledger.
 */
export async function measureFolder(path: string, budget: WalkBudget): Promise<FolderSize> {
  const size: FolderSize = { bytes: 0, entries: 0, complete: true };
  const pending = [path];
  while (pending.length) {
    const directory = pending.pop();
    if (directory === undefined) break;
    if (spent(budget)) return { ...size, complete: false };
    let dir;
    try {
      dir = await opendir(directory);
    } catch {
      continue;
    }
    const files: string[] = [];
    let cut = false;
    try {
      for await (const entry of dir) {
        if (spent(budget)) {
          cut = true;
          break;
        }
        budget.entries--;
        size.entries++;
        const child = join(directory, entry.name);
        if (entry.isDirectory()) pending.push(child);
        else files.push(child);
      }
    } catch {
      // A folder removed mid-walk: what was read so far still counts.
    }
    for (let start = 0; start < files.length; start += LSTAT_BATCH) {
      const sizes = await Promise.all(
        files.slice(start, start + LSTAT_BATCH).map((file) =>
          lstat(file).then(
            (stat) => stat.size,
            () => 0,
          ),
        ),
      );
      for (const bytes of sizes) size.bytes += bytes;
    }
    if (cut) return { ...size, complete: false };
  }
  return size;
}
