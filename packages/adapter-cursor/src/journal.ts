import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import type { CheckpointQuota } from "./checkpoint-quota.ts";
import { open, lstat, rename } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import {
  compactionSuffix,
  copyTail,
  observeOf,
  parseHeader,
  syncDirectory,
  unlinkIfPresent,
  writeCompacted,
} from "./journal-compaction.ts";
import { boundedJson } from "@ace/provider-kit/ipc";
import { Envelope, type CursorEnvelope } from "./contracts.ts";

type Pending = {
  frame: CursorEnvelope;
  bytes: number;
  resolve(value: CursorEnvelope): void;
  reject(error: unknown): void;
};

/**
 * Redacted callbacks are committed before IPC. This cursor is NOT an SDK ObserveRun offset.
 * Frames ace has stored are trimmed at settled turns (ADR 0211): the journal then starts with a
 * header carrying the last dropped offset and the observe offsets recovery would have rebuilt.
 */
export class CursorJournal {
  private path: string;
  private root: string;
  /** Offset of the last frame dropped by compaction; 0 for a journal never compacted. */
  private base = 0;
  /** Offset ace has confirmed it stored, and the one confirmed at the previous safe point. */
  private acknowledged = 0;
  private settledAt = 0;
  /** Serializes group writes with the compaction swap. */
  private gate: Promise<void> = Promise.resolve();
  private compacting: Promise<void> | undefined;
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
  private headerBytes = 0;
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
    this.root = root;
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
    // A compaction interrupted before its rename leaves the old journal whole; drop its scratch.
    await unlinkIfPresent(this.path + compactionSuffix);
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
        const value: unknown = JSON.parse(line);
        const header = this.bytes === this.headerBytes ? parseHeader(value) : undefined;
        if (header) {
          if (this.headerBytes && header.baseOffset !== this.base)
            throw new Error("SDK journal header conflicts with itself");
          this.base = this.offset = header.baseOffset;
          for (const [runId, at] of header.observe) this.observe(runId, at);
          this.bytes += Buffer.byteLength(line) + 1;
          this.headerBytes = this.bytes;
          continue;
        }
        const frame = Envelope.parse(value);
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
      // Frames up to the base were dropped once ace had stored them; a cursor before it means
      // ace lost frames this journal no longer holds.
      if (after < this.base)
        throw new Error("SDK recovery cursor predates its compacted journal; use context handoff");
      this.acknowledged = this.settledAt = after;
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
    const observed = observeOf(frame);
    if (observed) this.observe(...observed);
  }
  private observe(runId: string, offset: string): void {
    if (!this.observeOffsets.has(runId) && this.observeOffsets.size >= this.identities)
      throw new Error("SDK observe identity budget exceeded");
    this.observeOffsets.set(runId, offset);
  }
  /** ace has stored every frame up to `offset`; only such frames are ever compacted away. */
  acknowledge(offset: number): void {
    this.acknowledged = Math.max(this.acknowledged, Math.min(offset, this.offset));
  }
  /**
   * A turn has settled: trims the frames ace had confirmed by the previous safe point. The one
   * safe point of lag keeps a frame ace stored moments ago until ace has stored more after it.
   * Runs in the background; resolves once done and never rejects. A failure before the swap
   * leaves the journal as it was; one after it fences the journal, which recovers on reopen.
   */
  settle(): Promise<void> {
    const target = this.settledAt;
    this.settledAt = this.acknowledged;
    if (this.compacting || !this.ready || this.failed || this.closing || target <= this.base)
      return Promise.resolve();
    const compacting = this.compact(target).catch(() => {});
    this.compacting = compacting.finally(() => {
      this.compacting = undefined;
    });
    return this.compacting;
  }
  private async compact(target: number): Promise<void> {
    const temp = this.path + compactionSuffix;
    const snapshot = await this.exclusive(async () => ({ bytes: this.bytes, offset: this.offset }));
    if (snapshot.offset < target) return;
    const written = await writeCompacted({
      path: this.path,
      temp,
      bytes: snapshot.bytes,
      target,
      maxFrameBytes: this.maxFrameBytes,
    });
    let swapped = false;
    try {
      if (written.lastOffset !== snapshot.offset)
        throw new Error("SDK journal changed under compaction");
      // A rewrite costs the bytes kept, so it waits until the dropped prefix is at least as large.
      if (snapshot.bytes - written.bytes < written.bytes) return;
      const swap = async () => {
        const file = this.file;
        if (!file || this.failed || this.closing) return;
        let bytes: number;
        try {
          // Frames appended since the snapshot are copied byte for byte, under the write gate.
          await copyTail(this.path, snapshot.bytes, this.bytes, written.file);
          await this.sync(written.file);
          bytes = written.bytes + (this.bytes - snapshot.bytes);
          await written.file.close();
          await rename(temp, this.path);
        } catch {
          // Nothing replaced the journal: it stays whole and appendable, and the quota unfenced.
          return;
        }
        swapped = true;
        try {
          await syncDirectory(this.root);
          await file.close();
          this.file = await open(
            this.path,
            constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW,
          );
        } catch (error) {
          // The new journal is on disk and recovers; this host can no longer append to it.
          this.failed = true;
          this.file = undefined;
          throw error;
        }
        this.base = target;
        this.bytes = bytes;
      };
      // The quota re-reads the journal's size afterwards, so its ledger shrinks with the file.
      await this.exclusive(() => (this.quota ? this.quota.journal(0, swap) : swap()));
    } finally {
      if (!swapped) {
        await written.file.close().catch(() => {});
        await unlinkIfPresent(temp);
      }
    }
  }
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.gate.then(operation);
    this.gate = run.then(
      () => {},
      () => {},
    );
    return run;
  }
  close(): Promise<void> {
    this.closing ??= (async () => {
      // Fence new admission, but drain callbacks already accepted before close.
      while (this.draining) await this.tail;
      this.ready = false;
      await this.compacting;
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
        await this.exclusive(() => (this.quota ? this.quota.journal(size, write) : write()));
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
