import { createWriteStream, type WriteStream } from "node:fs";
import { finished } from "node:stream/promises";
import type { BackendLog } from "./backend.ts";
import { redactBrowserText, redactBrowserUrl } from "./inspection.ts";
import { join } from "node:path";

/** Append-only JSONL, bounded by file size and the writable high-water mark. */
export class SessionLogs {
  readonly paths: { console: string; network: string };
  private streams: Record<"console" | "network", WriteStream>;
  private bytes = { console: 0, network: 0 };
  private failures = new Map<string, unknown>();
  private closing = false;
  private retained: (BackendLog & { at: number })[] = [];
  read(filter: {
    kind?: "console" | "network" | undefined;
    level?: string | undefined;
    url?: string | undefined;
    status?: number | undefined;
    limit: number;
  }) {
    return {
      entries: this.retained
        .filter(
          (entry) =>
            (!filter.kind || entry.kind === filter.kind) &&
            (!filter.level || entry.type === filter.level) &&
            (!filter.url || entry.url?.includes(filter.url)) &&
            (filter.status === undefined || entry.status === filter.status),
        )
        .slice(-filter.limit),
      limit: filter.limit,
    };
  }
  constructor(dir: string, privateLimit = 16 * 1024 * 1024) {
    this.limit = privateLimit;
    this.paths = { console: join(dir, "console.jsonl"), network: join(dir, "network.jsonl") };
    this.streams = {
      console: createWriteStream(this.paths.console, {
        flags: "a",
        mode: 0o600,
        highWaterMark: 64 * 1024,
      }),
      network: createWriteStream(this.paths.network, {
        flags: "a",
        mode: 0o600,
        highWaterMark: 64 * 1024,
      }),
    };
    for (const [kind, stream] of Object.entries(this.streams))
      stream.on("error", (error) => this.failures.set(kind, error));
  }
  private limit: number;
  append(kind: "console" | "network", entry: Omit<BackendLog, "kind"> & { at: number }): boolean {
    entry = {
      ...entry,
      text: redactBrowserText(entry.text).slice(0, 8192),
      ...(entry.url ? { url: redactBrowserUrl(entry.url) } : {}),
    };
    if (this.retained.length >= 200) this.retained.shift();
    this.retained.push({ ...entry, kind });
    const stream = this.streams[kind];
    if (this.closing || this.failures.has(kind) || stream.writableNeedDrain) return false;
    const line = JSON.stringify({ ...entry, text: entry.text.slice(0, 8192) }) + "\n";
    const bytes = Buffer.byteLength(line);
    if (this.bytes[kind] + bytes > this.limit) return false;
    this.bytes[kind] += bytes;
    stream.write(line);
    return true;
  }
  async flush(): Promise<void> {
    await Promise.all(
      Object.values(this.streams).map(
        (stream) =>
          new Promise<void>((resolve, reject) => {
            if (stream.destroyed) {
              reject(new Error("Browser log stream closed"));
              return;
            }
            stream.write("", (error) => (error ? reject(error) : resolve()));
          }),
      ),
    );
  }
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    await Promise.all(
      Object.values(this.streams).map(async (stream) => {
        stream.end();
        await finished(stream);
      }),
    );
  }
}
