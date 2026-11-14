import { transferChunkBytes } from "@ace/protocol";

/** The first chunk of a transfer, before any throughput is known: 21 s at 400 kbit/s. */
const FIRST_CHUNK_BYTES = 1024 * 1024;
/** The smallest chunk, so even a very slow link makes steady, acknowledged progress. */
const MIN_CHUNK_BYTES = 256 * 1024;
/** Chunks are sized to take about this long at the measured throughput. */
const CHUNK_TARGET_MS = 20_000;
/** Chunk sizes are whole multiples of this. */
const CHUNK_STEP_BYTES = 64 * 1024;
/** A chunk's timeout before any throughput is known, as it always was. */
const UNKNOWN_TIMEOUT_MS = 120_000;
const MIN_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Chunk sizes and timeouts for one upload, from the throughput its acknowledged chunks showed:
 * a slow link sends smaller chunks, each given time in proportion to its size, so no chunk times
 * out again and again and is sent whole each time. A timeout halves the estimate, so the retry
 * is smaller. Pure: the caller passes each chunk's size and how long its answer took.
 */
export class ChunkPace {
  /** Bytes per millisecond, smoothed; undefined until a chunk is acknowledged. */
  private rate: number | undefined;
  /** The next chunk's size, at most `remaining` bytes. */
  size(remaining: number): number {
    const wanted =
      this.rate === undefined
        ? FIRST_CHUNK_BYTES
        : Math.floor((this.rate * CHUNK_TARGET_MS) / CHUNK_STEP_BYTES) * CHUNK_STEP_BYTES;
    return Math.min(remaining, Math.max(MIN_CHUNK_BYTES, Math.min(transferChunkBytes, wanted)));
  }
  /** How long a chunk of `bytes` may take before it is given up and sent again. */
  timeoutMs(bytes: number): number {
    if (this.rate === undefined) return UNKNOWN_TIMEOUT_MS;
    const expected = bytes / this.rate;
    return Math.round(Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, 15_000 + 4 * expected)));
  }
  /** A chunk of `bytes` was acknowledged `ms` after it was sent. */
  sent(bytes: number, ms: number): void {
    const rate = bytes / Math.max(1, ms);
    this.rate = this.rate === undefined ? rate : 0.7 * this.rate + 0.3 * rate;
  }
  /** A chunk of `bytes` timed out after `ms`: the link is slower than that. */
  timedOut(bytes: number, ms: number): void {
    const ceiling = bytes / Math.max(1, ms);
    this.rate = Math.min(this.rate ?? ceiling, ceiling) / 2;
  }
}
