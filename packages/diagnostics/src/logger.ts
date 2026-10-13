import { bounded, logMetadata } from "./bounded.ts";
import { overflowVictim } from "./log-policy.ts";
export type Level = "debug" | "info" | "warn" | "error";
export interface LogRecord {
  at: number;
  level: Level;
  component: string;
  message: string;
  data: unknown;
}
export interface BatchSink {
  /** One durable append per call. Calls never overlap. */
  write(records: readonly LogRecord[]): Promise<void>;
  close(): Promise<void>;
  /** Apply a new per-stream disk cap. Serialized with writes. */
  resize?(totalBytes: number): Promise<void>;
  /** Crash path: append synchronously because the event loop may never turn again. */
  writeSync?(records: readonly LogRecord[]): void;
}
export interface LoggerOptions {
  sink: BatchSink;
  now: () => number;
  redact: (line: string) => string;
  level?: Level | "silent";
  capacity?: number;
  recentCapacity?: number;
  /** Records per sink write. A full batch flushes without waiting for the interval. */
  batchSize?: number;
  /** Longest a record waits in memory before its batch is written. */
  flushMs?: number;
  /** Deferred flush scheduler; tests substitute it. */
  schedule?: (callback: () => void, delayMs: number) => void;
}
export interface ComponentLogger {
  log(level: Level, message: string, data?: unknown): void;
  child(component: string): ComponentLogger;
}
const rank = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 };
const timer = (callback: () => void, delayMs: number) => {
  setTimeout(callback, delayMs).unref();
};
/**
 * Buffers records in memory and writes them in batches: at most one sink call per
 * `batchSize` records, and a record waits at most `flushMs`. A full buffer gives up its
 * oldest least-important record and counts it.
 */
export function createLogger(options: LoggerOptions) {
  const capacity = options.capacity ?? 4096;
  const recentCapacity = options.recentCapacity ?? 256;
  const batchSize = options.batchSize ?? 512;
  const flushMs = options.flushMs ?? 250;
  for (const n of [capacity, recentCapacity, batchSize]) {
    if (!Number.isSafeInteger(n) || n < 1 || n > 65536)
      throw new RangeError("Invalid log capacity");
  }
  if (!Number.isFinite(flushMs) || flushMs < 0 || flushMs > 60_000)
    throw new RangeError("Invalid log flush interval");
  const schedule = options.schedule ?? timer;
  let queue: LogRecord[] = [];
  let inFlight: readonly LogRecord[] = [];
  const ring: (LogRecord | undefined)[] = Array.from({ length: recentCapacity }, () => undefined);
  let ringIndex = 0,
    recentSize = 0;
  let dropped = 0,
    failed = 0,
    closed = false;
  // Pending deferred flush: the delay it was armed with, or undefined when none is armed.
  let armed: number | undefined;
  let closing: Promise<void> | undefined;
  let draining: Promise<void> | undefined;
  let tail: Promise<void> = Promise.resolve();
  /** Every sink call runs on one chain, so writes and resizes never overlap. */
  function exclusive(run: () => Promise<void>): Promise<void> {
    const next = tail.then(run, run);
    tail = next.catch(() => {});
    return next;
  }
  function drainOnce(): Promise<void> {
    draining ??= exclusive(async () => {
      while (queue.length > 0) {
        const batch = queue.length <= batchSize ? queue : queue.slice(0, batchSize);
        queue = queue.length <= batchSize ? [] : queue.slice(batchSize);
        inFlight = batch;
        try {
          await options.sink.write(batch);
        } catch {
          failed += batch.length;
        } finally {
          inFlight = [];
        }
      }
    }).finally(() => {
      draining = undefined;
    });
    return draining;
  }
  async function drain(): Promise<void> {
    do await drainOnce();
    while (queue.length > 0);
  }
  function arm(delayMs: number) {
    if (armed !== undefined && armed <= delayMs) return;
    armed = delayMs;
    schedule(() => {
      armed = undefined;
      void drain();
    }, delayMs);
  }
  function componentLogger(component: string): ComponentLogger {
    return {
      child(name) {
        return componentLogger(
          `${component}.${name.length > 128 ? "<OVERSIZED>" : name}`.slice(0, 128),
        );
      },
      log(level, message, data) {
        if (rank[level] < rank[options.level ?? "info"]) return;
        if (closed) {
          dropped++;
          return;
        }
        if (queue.length + inFlight.length >= capacity) {
          // The in-flight batch belongs to the sink; only queued records can be given up.
          const victim = overflowVictim(
            queue.map((record) => record.level),
            level,
          );
          dropped++;
          if (victim === "incoming" || queue.length === 0) return;
          queue.splice(victim, 1);
        }
        const record: LogRecord = {
          at: options.now(),
          level,
          component,
          message: message.length > 2048 ? "<OVERSIZED>" : message,
          data: bounded(data, options.redact),
        };
        queue.push(record);
        ring[ringIndex] = record;
        ringIndex = (ringIndex + 1) % recentCapacity;
        recentSize = Math.min(recentSize + 1, recentCapacity);
        arm(queue.length >= batchSize ? 0 : flushMs);
      },
    };
  }
  return {
    ...componentLogger("ace"),
    metadata: (value: unknown) => logMetadata(value, options.redact),
    stats: () => ({ dropped, failed, queued: queue.length + inFlight.length }),
    recent() {
      const lines: string[] = [];
      for (let i = 0; i < recentSize; i++) {
        const record = ring[(ringIndex - recentSize + i + recentCapacity) % recentCapacity];
        if (record) lines.push(options.redact(JSON.stringify(record)));
      }
      return lines;
    },
    flush: drain,
    /** Change the sink's disk cap after the records already buffered are written. */
    resize(totalBytes: number): Promise<void> {
      const resize = options.sink.resize;
      if (!resize) return Promise.resolve();
      return drain().then(() => exclusive(() => resize.call(options.sink, totalBytes)));
    },
    /**
     * Fatal-error path. Appends everything still in memory, including a batch the sink may
     * not have finished, with one synchronous write. A crash can therefore repeat the last
     * batch, but never loses it. Never throws.
     */
    flushSync(): void {
      const records = [...inFlight, ...queue];
      queue = [];
      if (!records.length || !options.sink.writeSync) return;
      try {
        options.sink.writeSync(records);
      } catch {
        failed += records.length;
      }
    },
    close() {
      closed = true;
      closing ??= drain().then(() => exclusive(() => options.sink.close()));
      return closing;
    },
  };
}
