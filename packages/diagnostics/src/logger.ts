import { bounded } from "./bounded.ts";
export type Level = "debug" | "info" | "warn" | "error";
export interface LogRecord {
  at: number;
  level: Level;
  component: string;
  message: string;
  data: unknown;
}
export interface BatchSink {
  write(records: readonly LogRecord[]): Promise<void>;
  close(): Promise<void>;
}
export interface LoggerOptions {
  sink: BatchSink;
  now: () => number;
  redact: (line: string) => string;
  level?: Level | "silent";
  capacity?: number;
  recentCapacity?: number;
  batchSize?: number;
  schedule?: (callback: () => void) => void;
}
export interface ComponentLogger {
  log(level: Level, message: string, data?: unknown): void;
  child(component: string): ComponentLogger;
}
const rank = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 };
export function createLogger(options: LoggerOptions) {
  const capacity = options.capacity ?? 1024;
  const recentCapacity = options.recentCapacity ?? 256;
  const batchSize = options.batchSize ?? 128;
  for (const n of [capacity, recentCapacity, batchSize]) {
    if (!Number.isSafeInteger(n) || n < 1 || n > 65536)
      throw new RangeError("Invalid log capacity");
  }
  const queue: (LogRecord | undefined)[] = Array.from({ length: capacity }, () => undefined);
  const ring: (LogRecord | undefined)[] = Array.from({ length: recentCapacity }, () => undefined);
  let head = 0,
    size = 0,
    ringIndex = 0,
    recentSize = 0,
    inFlight = 0;
  let dropped = 0,
    failed = 0,
    scheduled = false,
    closed = false;
  let closing: Promise<void> | undefined;
  let draining: Promise<void> | undefined;
  function drain(): Promise<void> {
    if (draining) return draining;
    draining = (async () => {
      while (size > 0) {
        const batch: LogRecord[] = [];
        while (size > 0 && batch.length < batchSize) {
          const record = queue[head];
          queue[head] = undefined;
          head = (head + 1) % capacity;
          size--;
          if (record) batch.push(record);
        }
        inFlight = batch.length;
        try {
          await options.sink.write(batch);
        } catch {
          failed += batch.length;
        } finally {
          inFlight = 0;
        }
      }
    })().finally(() => {
      draining = undefined;
    });
    return draining;
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
        if (closed || size + inFlight >= capacity) {
          dropped++;
          return;
        }
        const record: LogRecord = {
          at: options.now(),
          level,
          component,
          message: message.length > 2048 ? "<OVERSIZED>" : message,
          data: bounded(data),
        };
        queue[(head + size) % capacity] = record;
        size++;
        ring[ringIndex] = record;
        ringIndex = (ringIndex + 1) % recentCapacity;
        recentSize = Math.min(recentSize + 1, recentCapacity);
        if (!scheduled) {
          scheduled = true;
          (options.schedule ?? setImmediate)(() => {
            scheduled = false;
            void drain();
          });
        }
      },
    };
  }
  return {
    ...componentLogger("ace"),
    stats: () => ({ dropped, failed, queued: size + inFlight }),
    recent() {
      const lines: string[] = [];
      for (let i = 0; i < recentSize; i++) {
        const record = ring[(ringIndex - recentSize + i + recentCapacity) % recentCapacity];
        if (record) lines.push(options.redact(JSON.stringify(record)));
      }
      return lines;
    },
    flush: drain,
    close() {
      closed = true;
      closing ??= drain().then(() => options.sink.close());
      return closing;
    },
  };
}
