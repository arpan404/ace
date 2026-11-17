/**
 * When the disk under ACE_HOME is too full for the daemon to store new work (ADR 0176). Pure:
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

/**
 * `full` holds new work; `low` is only a warning. `unproven` marks a hold a refused write began:
 * free space read through `statfs` does not see a per-user quota (EDQUOT), so such a hold lifts
 * only once a probe write succeeds too, never on free space alone.
 */
export interface StorageState {
  full: boolean;
  low: boolean;
  unproven?: true;
}

export const roomyStorage: StorageState = { full: false, low: false };

/**
 * What the daemon learned: a write failed for want of space, the volume's free bytes were read
 * (null when they could not be, which changes nothing), or a probe write after such a read
 * succeeded (`ok`) or was refused for want of space.
 */
export type StorageFact =
  | { kind: "write-failed" }
  | { kind: "free"; bytes: number | null }
  | { kind: "probe"; ok: boolean; bytes: number };

/** Whether a read of `bytes` would lift the hold, were it not waiting on a probe write. */
export function roomToResume(bytes: number | null, levels: StorageLevels = storageLevels): boolean {
  return bytes !== null && bytes >= levels.resumeAt;
}

export function nextStorageState(
  state: StorageState,
  fact: StorageFact,
  levels: StorageLevels = storageLevels,
): StorageState {
  if (fact.kind === "write-failed") return { full: true, low: true, unproven: true };
  if (fact.kind === "probe")
    return fact.ok
      ? nextStorageState(
          { full: state.full, low: state.low },
          { kind: "free", bytes: fact.bytes },
          levels,
        )
      : state;
  if (fact.bytes === null) return state;
  // Room on the volume says nothing of a quota: the probe decides (`storage-watch.ts`).
  if (state.full && state.unproven) return state;
  const full = state.full ? fact.bytes < levels.resumeAt : fact.bytes < levels.pauseBelow;
  return { full, low: full || fact.bytes < levels.warnBelow };
}
