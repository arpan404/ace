import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import type { CheckpointQuota } from "./checkpoint-quota.ts";
import { open, lstat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { boundedJson } from "@ace/provider-kit/ipc";
import { Envelope, type CursorEnvelope } from "./contracts.ts";

type Pending = {
  frame: CursorEnvelope;
  bytes: number;
  resolve(value: CursorEnvelope): void;
  reject(error: unknown): void;
};

/** Redacted callbacks are committed before IPC. This cursor is NOT an SDK ObserveRun offset. */
export class CursorJournal {
  private path: string;
  private file: FileHandle | undefined;
  private quota: CheckpointQuota | undefined;
  private offset = 0;
  private bytes = 0;
  private maxBytes: number;
  private maxFrameBytes: number;
  private tail: Promise<void> = Promise.resolve();
  private failed = false;
  private closing: Promise<void> | undefined;
  private draining = false;
  private pending: Pending[] = [];
  private sync: (file: FileHandle) => Promise<void>;
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
      quota?: CheckpointQuota;
      /** Filesystem durability boundary; injected barriers never replace admission. */
      sync?: (file: FileHandle) => Promise<void>;
    } = {},
  ) {
    this.quota = options.quota;
    this.sync = options.sync ?? ((file) => file.sync());
    this.now = options.now ?? Date.now;
    this.identities = options.maxIdentities ?? 2048;
    this.pendingLimit = options.maxPendingBytes ?? 2097152;
    this.callbacks = options.maxCallbacks ?? 32;
    this.path = join(root, "ace-boundary.ndjson");
    this.maxBytes = maxBytes;
    this.maxFrameBytes = maxFrameBytes;
  }
  async recover(after: number, consume: (frame: CursorEnvelope) => Promise<void>): Promise<void> {
    if (this.ready || this.offset > 0 || this.closing)
      throw new Error("SDK journal already initialized");
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
      this.file = await open(
        this.path,
        constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW,
      );
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
  close(): Promise<void> {
    this.closing ??= (async () => {
      // Fence new admission, but drain callbacks already accepted before close.
      while (this.draining) await this.tail;
      this.ready = false;
      await this.file?.close();
      this.file = undefined;
    })();
    return this.closing;
  }
  async append(frame: CursorEnvelope): Promise<CursorEnvelope> {
    if (this.failed || !this.ready || this.closing)
      throw new Error("SDK journal is fenced or uninitialized");
    const prepared = boundedJson(frame, this.maxFrameBytes - 128);
    const parsed = Envelope.parse(JSON.parse(prepared));
    const bytes = Buffer.byteLength(prepared) + 128;
    if (this.queued >= this.callbacks || this.pendingBytes + bytes > this.pendingLimit)
      throw new Error("SDK journal pending bytes/callback budget exceeded");
    this.queued++;
    this.pendingBytes += bytes;
    const completion = Promise.withResolvers<CursorEnvelope>();
    this.pending.push({ frame: parsed, bytes, ...completion });
    if (!this.draining) this.schedule();
    return completion.promise;
  }
  private schedule(): void {
    this.draining = true;
    // Coalesce the bounded callbacks already admitted in this microtask turn.
    // Sequential callbacks still wait for a durable commit: no timer window.
    this.tail = Promise.resolve()
      .then(() => this.drain())
      .finally(() => {
        this.draining = false;
        // Promise consumers may enqueue during the final group's resolution.
        if (this.pending.length) this.schedule();
      });
  }
  private release(pending: Pending): void {
    this.queued--;
    this.pendingBytes -= pending.bytes;
  }
  private async drain(): Promise<void> {
    while (this.pending.length) {
      const group = this.pending;
      this.pending = [];
      try {
        const committed = group.map(({ frame }, index) =>
          Envelope.parse({
            ...frame,
            boundaryOffset: this.offset + index + 1,
            recordedAt: this.now(),
          }),
        );
        const encoded = committed.map((frame) => boundedJson(frame, this.maxFrameBytes) + "\n");
        const size = encoded.reduce((sum, line) => sum + Buffer.byteLength(line), 0);
        if (this.bytes + size > this.maxBytes)
          throw new Error("SDK boundary journal exceeds recovery budget; use context handoff");
        const write = async () => {
          const file = this.file;
          if (!file) throw new Error("SDK journal closed");
          for (const line of encoded) await file.writeFile(line);
          await this.sync(file);
        };
        if (this.quota) await this.quota.journal(size, write);
        else await write();
        for (const frame of committed) this.rememberObserve(frame);
        this.offset += committed.length;
        this.bytes += size;
        for (const [index, pending] of group.entries()) {
          const frame = committed[index];
          if (!frame) throw new Error("Missing SDK group commit");
          this.release(pending);
          pending.resolve(frame);
        }
      } catch (error) {
        // Partial writes are uncertain, never truncated or re-admitted. Recovery
        // validates each complete offset and refuses a torn tail.
        this.failed = true;
        for (const pending of [...group, ...this.pending]) {
          this.release(pending);
          pending.reject(error);
        }
        this.pending = [];
      }
    }
  }
}
