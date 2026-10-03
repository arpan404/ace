import { constants } from "node:fs";
import { open, lstat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { boundedJson } from "@ace/provider-kit/ipc";
import { Envelope, type CursorEnvelope } from "./contracts.ts";

/** Redacted callbacks are committed before IPC. This cursor is NOT an SDK ObserveRun offset. */
export class CursorJournal {
  private path: string;
  private offset = 0;
  private bytes = 0;
  private maxBytes: number;
  private maxFrameBytes: number;
  private tail: Promise<void> = Promise.resolve();
  private failed = false;
  private now: () => number;
  private identities: number;
  private queued = 0;
  private pendingBytes = 0;
  private pendingLimit: number;
  private callbacks: number;
  private ready = false;
  private observeOffsets = new Map<string, string>();
  constructor(
    root: string,
    maxBytes: number,
    maxFrameBytes: number,
    options: {
      now?: () => number;
      maxIdentities?: number;
      maxPendingBytes?: number;
      maxCallbacks?: number;
    } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.identities = options.maxIdentities ?? 2048;
    this.pendingLimit = options.maxPendingBytes ?? 2097152;
    this.callbacks = options.maxCallbacks ?? 32;
    this.path = join(root, "ace-boundary.ndjson");
    this.maxBytes = maxBytes;
    this.maxFrameBytes = maxFrameBytes;
  }
  async recover(after: number, consume: (frame: CursorEnvelope) => Promise<void>): Promise<void> {
    if (this.ready || this.offset > 0) throw new Error("SDK journal already initialized");
    const file = await open(
      this.path,
      constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    await file.close();
    const stat = await lstat(this.path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > this.maxBytes)
      throw new Error("Unsafe or oversized SDK boundary journal; use context handoff");
    const stream = createReadStream(this.path, { highWaterMark: 4096 });
    const lines = createInterface({
      input: stream,
      crlfDelay: Infinity,
    });
    try {
      for await (const line of lines) {
        if (Buffer.byteLength(line) > this.maxFrameBytes)
          throw new Error("Oversized SDK journal frame");
        const frame = Envelope.parse(JSON.parse(line));
        if (frame.boundaryOffset !== this.offset + 1)
          throw new Error("SDK journal has an incomplete or unordered commit");
        this.rememberObserve(frame);
        this.offset++;
        this.bytes += Buffer.byteLength(line) + 1;
        if (this.offset > after) await consume({ ...frame, replayed: true });
      }
      // A torn final write is never silently truncated or interpreted as delivered.
      if (this.bytes !== stat.size || after > this.offset)
        throw new Error("SDK recovery cursor conflicts with its journal");
      this.ready = true;
    } catch (error) {
      this.failed = true;
      throw error;
    } finally {
      lines.close();
      stream.destroy();
    }
  }
  afterObserve(runId: string): string | undefined {
    return this.observeOffsets.get(runId);
  }
  private rememberObserve(frame: CursorEnvelope): void {
    if (!["observe", "recovery"].includes(frame.kind) || !frame.observeOffset || !frame.runId)
      return;
    if (!this.observeOffsets.has(frame.runId) && this.observeOffsets.size >= this.identities)
      throw new Error("SDK observe identity budget exceeded");
    this.observeOffsets.set(frame.runId, frame.observeOffset);
  }
  async append(frame: CursorEnvelope): Promise<CursorEnvelope> {
    const prepared = boundedJson(frame, this.maxFrameBytes - 128);
    const parsed = Envelope.parse(JSON.parse(prepared));
    const bytes = Buffer.byteLength(prepared);
    if (this.queued >= this.callbacks || this.pendingBytes + bytes > this.pendingLimit)
      return Promise.reject(new Error("SDK journal pending bytes/callback budget exceeded"));
    this.queued++;
    this.pendingBytes += bytes;
    const work = this.tail.then(async () => {
      if (this.failed || !this.ready) throw new Error("SDK journal is fenced or uninitialized");
      const committed = Envelope.parse({
        ...parsed,
        boundaryOffset: this.offset + 1,
        recordedAt: this.now(),
      });
      const encoded = boundedJson(committed, this.maxFrameBytes) + "\n";
      const size = Buffer.byteLength(encoded);
      if (this.bytes + size > this.maxBytes)
        throw new Error("SDK boundary journal exceeds recovery budget; use context handoff");
      const file = await open(
        this.path,
        constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await file.writeFile(encoded);
        await file.sync();
      } finally {
        await file.close();
      }
      this.rememberObserve(committed);
      this.offset++;
      this.bytes += size;
      return committed;
    });
    this.tail = work.then(
      () => {},
      () => {
        this.failed = true;
      },
    );
    return work.finally(() => {
      this.queued--;
      this.pendingBytes -= bytes;
    });
  }
}
