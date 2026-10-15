import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";

export interface FileLogOptions {
  directory: string;
  /** `desktop` writes `desktop.jsonl`, rotated to `desktop.1.jsonl` … `desktop.<rotations>.jsonl`. */
  name: string;
  /** Size of one file. A line that would take the current file past it rotates first. */
  maxBytes: number;
  /** Rotated files kept beside the current one; the oldest is replaced. */
  rotations: number;
  /** Lines waiting in memory, in bytes. Lines past it are dropped and counted. */
  maxQueuedBytes?: number;
  /** Longest a line waits in memory before its batch is written. */
  flushMs?: number;
  /** Deferred flush scheduler. */
  schedule(callback: () => void, delayMs: number): void;
}

/** A size-capped, rotating line file. Writing never throws into the caller. */
export interface FileLog {
  /** Queue one line (a newline is added). */
  append(line: string): void;
  /** Resolves once every line queued so far has been written or counted as failed. */
  flush(): Promise<void>;
  /** Exit path: write what is still queued with one synchronous append. */
  flushSync(): void;
  stats(): { dropped: number; failed: number; queued: number };
}

const absent = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

export function createFileLog(options: FileLogOptions): FileLog {
  const maxQueuedBytes = options.maxQueuedBytes ?? 1024 * 1024;
  const flushMs = options.flushMs ?? 250;
  const file = (index: number) =>
    join(
      options.directory,
      index === 0 ? `${options.name}.jsonl` : `${options.name}.${index}.jsonl`,
    );
  const current = file(0);
  let queue: string[] = [];
  let queuedBytes = 0;
  let dropped = 0;
  let failed = 0;
  let armed = false;
  /** Bytes in the current file, read from disk again after any failed write. */
  let currentBytes: number | undefined;
  let tail: Promise<void> = Promise.resolve();

  async function size(): Promise<number> {
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    return stat(current).then(
      (info) => info.size,
      (error: unknown) => {
        if (absent(error)) return 0;
        throw error;
      },
    );
  }
  async function rotate(): Promise<void> {
    for (let index = options.rotations; index >= 1; index--)
      await rename(file(index - 1), file(index)).catch((error: unknown) => {
        if (!absent(error)) throw error;
      });
    currentBytes = 0;
  }
  async function write(lines: readonly string[]): Promise<void> {
    let bytes = (currentBytes ??= await size());
    let pending = "";
    let pendingBytes = 0;
    const commit = async () => {
      if (!pending) return;
      await appendFile(current, pending, { mode: 0o600 });
      bytes += pendingBytes;
      currentBytes = bytes;
      pending = "";
      pendingBytes = 0;
    };
    for (const line of lines) {
      const lineBytes = Buffer.byteLength(line);
      if (bytes + pendingBytes > 0 && bytes + pendingBytes + lineBytes > options.maxBytes) {
        await commit();
        await rotate();
        bytes = 0;
      }
      pending += line;
      pendingBytes += lineBytes;
    }
    await commit();
  }
  function take(): string[] {
    const lines = queue;
    queue = [];
    queuedBytes = 0;
    return lines;
  }
  async function writeQueued(): Promise<void> {
    const lines = take();
    if (!lines.length) return;
    try {
      await write(lines);
    } catch {
      failed += lines.length;
      currentBytes = undefined;
    }
  }
  /** Writes run one at a time, in order. */
  function drain(): Promise<void> {
    tail = tail.then(writeQueued, writeQueued);
    return tail;
  }
  return {
    append(text) {
      const line = text + "\n";
      const bytes = Buffer.byteLength(line);
      if (bytes > options.maxBytes || queuedBytes + bytes > maxQueuedBytes) {
        dropped++;
        return;
      }
      queue.push(line);
      queuedBytes += bytes;
      if (armed) return;
      armed = true;
      options.schedule(() => {
        armed = false;
        void drain();
      }, flushMs);
    },
    async flush() {
      await drain();
    },
    flushSync() {
      const lines = take();
      if (!lines.length) return;
      try {
        const text = lines.join("");
        mkdirSync(options.directory, { recursive: true, mode: 0o700 });
        let bytes = 0;
        try {
          bytes = statSync(current).size;
        } catch (error) {
          if (!absent(error)) throw error;
        }
        if (bytes > 0 && bytes + Buffer.byteLength(text) > options.maxBytes) {
          for (let index = options.rotations; index >= 1; index--)
            try {
              renameSync(file(index - 1), file(index));
            } catch (error) {
              if (!absent(error)) throw error;
            }
        }
        appendFileSync(current, text, { mode: 0o600 });
        currentBytes = undefined;
      } catch {
        failed += lines.length;
      }
    },
    stats: () => ({ dropped, failed, queued: queue.length }),
  };
}
