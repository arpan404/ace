/*
 * How long a client keeps what it read between sessions (ADR 0105). Pure: the caller lists what
 * is kept and passes the time; this answers what to let go.
 *
 * - Anything unused for seven days goes.
 * - Unsettled threads (working, waiting, needing the person, done but not settled) are kept
 *   whatever their number.
 * - Of settled threads, only the most recently used twenty are kept.
 * - Past the byte cap, the least recently used go: settled threads first, then other records,
 *   then unsettled threads. The most recently used entry always stays.
 */

const day = 24 * 60 * 60 * 1000;

export interface RetentionPolicy {
  /** Kept data unused for this long is let go. */
  maxAgeMs: number;
  /** At most this many settled threads are kept. */
  settledThreads: number;
  /** A safety net: everything kept together stays under this many bytes. */
  maxBytes: number;
}

export const snapshotRetention: RetentionPolicy = {
  maxAgeMs: 7 * day,
  settledThreads: 20,
  maxBytes: 64 * 1024 * 1024,
};

export interface KeptSnapshot {
  key: string;
  /** `thread`: a transcript kept as one row per item; `record`: any other view's record. */
  kind: "thread" | "record";
  /** When it was last read or written, in the clock's milliseconds. */
  used: number;
  bytes: number;
  /** A thread the inbox shows as settled. Always false for records. */
  settled: boolean;
}

/** The keys to let go at `now`. */
export function expiredSnapshots(
  kept: readonly KeptSnapshot[],
  now: number,
  policy: RetentionPolicy = snapshotRetention,
): string[] {
  const drop = new Set<string>();
  const recent = kept.toSorted((a, b) => b.used - a.used);
  let settled = 0;
  for (const entry of recent) {
    if (now - entry.used >= policy.maxAgeMs) drop.add(entry.key);
    else if (entry.kind === "thread" && entry.settled && ++settled > policy.settledThreads)
      drop.add(entry.key);
  }
  const left = recent.filter((entry) => !drop.has(entry.key));
  let total = left.reduce((sum, entry) => sum + entry.bytes, 0);
  if (total <= policy.maxBytes) return [...drop];
  const newest = left[0]?.key;
  const order = left.toSorted((a, b) => rank(a) - rank(b) || a.used - b.used);
  for (const entry of order) {
    if (total <= policy.maxBytes) break;
    if (entry.key === newest) continue;
    drop.add(entry.key);
    total -= entry.bytes;
  }
  return [...drop];
}

/** Which kind goes first past the byte cap. */
function rank(entry: KeptSnapshot): number {
  if (entry.kind === "record") return 1;
  return entry.settled ? 0 : 2;
}
