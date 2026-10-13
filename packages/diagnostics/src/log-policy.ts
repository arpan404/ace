/** Pure log retention and buffering policy. No I/O, clocks or timers. */

export const DEFAULT_LOG_MAX_BYTES = 1024 ** 3;
export const MIN_LOG_MAX_BYTES = 1024 * 1024;
export const MAX_LOG_MAX_BYTES = 64 * 1024 ** 3;
const MIN_SEGMENT_BYTES = 128;
const MAX_SEGMENT_BYTES = 64 * 1024 * 1024;

/**
 * Segment size for a per-stream cap. Eight or more segments keep deletion granular, so
 * rotating away the oldest segment never discards more than an eighth of the history.
 */
export function logSegmentBytes(maxBytes: number): number {
  return Math.max(MIN_SEGMENT_BYTES, Math.min(MAX_SEGMENT_BYTES, Math.floor(maxBytes / 8)));
}

export interface LogSegment {
  name: string;
  bytes: number;
}

/**
 * Oldest-first segments to delete so that `currentBytes + incomingBytes` fits beside the
 * remaining rotated segments. Returns every segment when even that is not enough; the
 * caller then also truncates the current file.
 */
export function segmentsToEvict(
  rotated: readonly LogSegment[],
  currentBytes: number,
  incomingBytes: number,
  maxBytes: number,
): { evict: LogSegment[]; truncateCurrent: boolean } {
  let total = currentBytes + incomingBytes + rotated.reduce((sum, file) => sum + file.bytes, 0);
  const evict: LogSegment[] = [];
  for (const segment of rotated) {
    if (total <= maxBytes) break;
    evict.push(segment);
    total -= segment.bytes;
  }
  return { evict, truncateCurrent: total > maxBytes };
}

const rank = { debug: 0, info: 1, warn: 2, error: 3 } as const;
export type BufferedLevel = keyof typeof rank;

/**
 * Which record a full buffer gives up for an incoming one: the oldest record of the lowest
 * level present, so debug detail goes first and errors are kept longest. Returns
 * `"incoming"` when the incoming record is strictly less important than everything queued.
 */
export function overflowVictim(
  queued: readonly BufferedLevel[],
  incoming: BufferedLevel,
): number | "incoming" {
  let victim = -1;
  for (let index = 0; index < queued.length; index++) {
    const level = queued[index];
    if (level === undefined) continue;
    if (victim < 0 || rank[level] < rank[queued[victim] ?? "error"]) victim = index;
    if (rank[level] === 0) break;
  }
  const lowest = victim < 0 ? undefined : queued[victim];
  if (lowest === undefined || rank[incoming] < rank[lowest]) return "incoming";
  return victim;
}

/** `1073741824`, `1024m`, `1g`, `512MiB`: binary units, case-insensitive. */
export function parseByteSize(input: string): number | undefined {
  const match = /^\s*(\d{1,16})\s*(k|m|g|t)?(?:i?b)?\s*$/i.exec(input);
  if (!match?.[1]) return undefined;
  const unit = (match[2] ?? "").toLowerCase();
  const scale =
    unit === "k"
      ? 1024
      : unit === "m"
        ? 1024 ** 2
        : unit === "g"
          ? 1024 ** 3
          : unit === "t"
            ? 1024 ** 4
            : 1;
  const value = Number(match[1]) * scale;
  return Number.isSafeInteger(value) ? value : undefined;
}
