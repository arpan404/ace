/**
 * When the disk under ACE_HOME is too full for the daemon to store new work (ADR 0174). Pure:
 * the watch in `storage-watch.ts` reads free space and applies the result.
 *
 * Writes fail well before a volume reads zero (the reported crashes left 111-127 MB free), so new
 * work is held from `pauseBelow`, and only released at `resumeAt`, so one freed file never flaps
 * admission. `warnBelow` is the early warning before anything is held.
 */
export interface StorageLevels {
  pauseBelow: number;
  resumeAt: number;
  warnBelow: number;
}

const MiB = 1024 * 1024;
export const storageLevels: StorageLevels = {
  pauseBelow: 256 * MiB,
  resumeAt: 512 * MiB,
  warnBelow: 1024 * MiB,
};

/** `full` holds new work; `low` is only a warning. */
export interface StorageState {
  full: boolean;
  low: boolean;
}

export const roomyStorage: StorageState = { full: false, low: false };

/**
 * What the daemon learned: a write failed for want of space, or the volume's free bytes were
 * read (null when they could not be, which changes nothing).
 */
export type StorageFact = { kind: "write-failed" } | { kind: "free"; bytes: number | null };

export function nextStorageState(
  state: StorageState,
  fact: StorageFact,
  levels: StorageLevels = storageLevels,
): StorageState {
  if (fact.kind === "write-failed") return { full: true, low: true };
  if (fact.bytes === null) return state;
  const full = state.full ? fact.bytes < levels.resumeAt : fact.bytes < levels.pauseBelow;
  return { full, low: full || fact.bytes < levels.warnBelow };
}
