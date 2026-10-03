import { beginUpload } from "./upload-admission.ts";
import { BlobLeases, type BlobLease } from "./blob-leases.ts";
import { constants } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { Attachment, BlobHash, ContextOperation, type ContextResult } from "@ace/protocol";
import { ContextError, requireContext } from "./errors.ts";
import { inspectBlob, defaultImageLimits } from "./media.ts";
import { Maintenance } from "./maintenance.ts";
import { Metadata, UploadRow } from "./metadata.ts";

import { defaultUploadLimits, type UploadOptions, type UploadLimits } from "./upload-options.ts";
export { defaultUploadLimits, type UploadOptions, type UploadLimits } from "./upload-options.ts";

type Result = ContextResult["result"];
export class UploadStore {
  private metadata: Metadata;
  private options: UploadOptions;
  private limits: UploadLimits;
  private tail: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private closing = false;
  private maintenance: Maintenance;
  private leases: BlobLeases;
  private constructor(options: UploadOptions) {
    this.options = options;
    this.limits = { ...defaultUploadLimits, ...options.limits };
    for (const value of Object.values(this.limits))
      requireContext(
        Number.isSafeInteger(value) && value > 0,
        "invalid_request",
        "Limits must be positive integers",
      );
    requireContext(
      this.limits.threadEntries <= 256,
      "invalid_request",
      "Thread reference cap cannot exceed wire limit",
    );
    this.metadata = new Metadata(join(options.root, "context.sqlite"), options.signal);
    this.tail = this.metadata.ready;
    this.leases = new BlobLeases(this.metadata);
    this.maintenance = new Maintenance(this.metadata, options.root, options.now, (row) =>
      this.removeUpload(row),
    );
  }
  get ready(): Promise<void> {
    return this.metadata.ready;
  }
  static async open(options: UploadOptions): Promise<UploadStore> {
    await mkdir(join(options.root, "uploads"), { recursive: true, mode: 0o700 });
    await mkdir(join(options.root, "blobs"), { recursive: true, mode: 0o700 });
    return new UploadStore(options);
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    requireContext(
      !this.closing && this.queued < this.limits.queued,
      "busy",
      "Attachment store busy",
    );
    this.queued++;
    const result = this.tail
      .then(async () => {
        await this.metadata.ready;
        return operation();
      })
      .finally(() => {
        this.queued--;
      });
    this.tail = result.catch(() => {});
    return result;
  }
  private temp(id: string): string {
    return join(this.options.root, "uploads", id);
  }
  private path(hash: string): string {
    return join(this.options.root, "blobs", hash);
  }
  private async authorized(device: string, thread: string): Promise<void> {
    requireContext(
      thread !== "*" &&
        thread.length <= 128 &&
        device.length <= 128 &&
        (await this.options.authorize(device, thread)),
      "forbidden",
      "Thread access denied",
    );
  }
  async handle(
    device: string,
    value: unknown,
    access: () => boolean = () => true,
  ): Promise<Result> {
    const op = ContextOperation.parse(value);
    return this.serialize(async () => {
      requireContext(access(), "forbidden", "Device access revoked");
      if (op.op === "upload.begin") {
        await this.authorized(device, op.threadId);
        return beginUpload(this.metadata, this.options, this.limits, device, op);
      }
      if (op.op === "attachment.list" || op.op === "attachment.release") {
        await this.authorized(device, op.threadId);
        if (op.op === "attachment.list")
          return { kind: "attachments", attachments: this.list(op.threadId) };
        this.release(op.threadId, op.sha256);
        return { kind: "ok" };
      }
      requireContext(
        op.op.startsWith("upload.") && "uploadId" in op,
        "invalid_request",
        "Not an upload operation",
      );
      const row = this.metadata.upload(op.uploadId);
      requireContext(row && row.device === device, "not_found", "Upload not found");
      await this.authorized(device, row.thread);
      requireContext(row.expires > this.options.now(), "not_found", "Upload expired");
      if (op.op === "upload.status")
        return { kind: "upload", uploadId: row.id, offset: row.offset, bytes: row.bytes };
      if (op.op === "upload.cancel") {
        await this.removeUpload(row);
        return { kind: "ok" };
      }
      if (op.op === "upload.commit")
        return { kind: "attachment", attachment: await this.commit(row) };
      requireContext(
        op.op === "upload.chunk" && !row.done,
        "invalid_request",
        "Upload already committed",
      );
      const bytes = Buffer.from(op.data, "base64");
      requireContext(
        bytes.length > 0 && bytes.length <= 64 * 1024 && bytes.toString("base64") === op.data,
        "invalid_request",
        "Invalid chunk encoding or size",
      );
      requireContext(
        op.offset + bytes.length <= row.bytes && op.offset <= row.offset,
        "offset",
        "Chunk offset or length is invalid",
      );
      const file = await open(this.temp(row.id), constants.O_RDWR | constants.O_NOFOLLOW);
      try {
        await file.truncate(row.offset);
        if (op.offset < row.offset) {
          requireContext(
            op.offset + bytes.length <= row.offset,
            "offset",
            "Retry overlaps acknowledged offset",
          );
          const previous = Buffer.alloc(bytes.length);
          const read = await file.read(previous, 0, previous.length, op.offset);
          requireContext(
            read.bytesRead === bytes.length && previous.equals(bytes),
            "offset",
            "Retry contains different bytes",
          );
        } else {
          let written = 0;
          while (written < bytes.length) {
            const result = await file.write(
              bytes,
              written,
              bytes.length - written,
              row.offset + written,
            );
            requireContext(
              result.bytesWritten > 0,
              "invalid_request",
              "Upload write made no progress",
            );
            written += result.bytesWritten;
          }
          await (this.options.syncChunk ? this.options.syncChunk(file) : file.sync());
          row.offset += bytes.length;
          this.metadata.run(
            "UPDATE uploads SET offset=?,expires=? WHERE id=?",
            row.offset,
            this.options.now() + this.limits.ttlMs,
            row.id,
          );
        }
      } finally {
        await file.close();
      }
      return { kind: "upload", uploadId: row.id, offset: row.offset, bytes: row.bytes };
    });
  }
  private list(thread: string): Attachment[] {
    return this.metadata
      .all(
        "SELECT b.metadata,r.name FROM refs r JOIN blobs b USING(sha256) WHERE r.thread=? ORDER BY r.sha256 LIMIT 256",
        thread,
      )
      .map((row) =>
        Attachment.parse({
          ...Attachment.parse(JSON.parse(z.string().parse(row.metadata))),
          name: row.name,
        }),
      );
  }
  private release(thread: string, hash: string): void {
    const existing = this.metadata.get(
      "SELECT sha256 FROM refs WHERE thread=? AND sha256=?",
      thread,
      hash,
    );
    const blob = this.metadata.blob(hash);
    if (!existing || !blob) return;
    this.metadata.transaction(() => {
      this.metadata.run("DELETE FROM refs WHERE thread=? AND sha256=?", thread, hash);
      this.metadata.run("UPDATE blobs SET refs=refs-1 WHERE sha256=?", hash);
      this.metadata.adjust(thread, -blob.bytes, -1);
    });
  }
  private async commit(row: UploadRow): Promise<Attachment> {
    if (row.done) {
      const blob = this.metadata.blob(row.sha256);
      const reference = this.metadata.get(
        "SELECT sha256 FROM refs WHERE thread=? AND sha256=?",
        row.thread,
        row.sha256,
      );
      requireContext(blob && reference, "not_found", "Committed blob no longer retained by thread");
      return { ...blob, name: row.name };
    }
    requireContext(row.offset === row.bytes, "offset", "Upload is incomplete");
    let attachment: Attachment;
    let candidate = this.temp(row.id);
    try {
      let file;
      try {
        file = await open(candidate, "r+");
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
        candidate = this.path(row.sha256);
        file = await open(candidate, "r+");
      }
      try {
        await file.truncate(row.offset);
        await file.sync();
      } finally {
        await file.close();
      }
      const inspected = await inspectBlob(
        candidate,
        this.options.imageLimits ?? defaultImageLimits,
      );
      requireContext(
        inspected.sha256 === row.sha256 && inspected.bytes === row.bytes,
        "hash_mismatch",
        "Upload hash does not match declared sha256",
      );
      attachment = Attachment.parse({ ...inspected, name: row.name });
    } catch (error) {
      await this.removeUpload(row);
      if (error instanceof ContextError) throw error;
      throw new ContextError("invalid_image", "Image header could not be validated");
    }
    const existing = this.metadata.blob(row.sha256);
    // Publish the verified bytes even when metadata exists. A crash during GC can
    // leave an unreferenced metadata row whose file has already been removed.
    if (candidate !== this.path(row.sha256)) await rename(candidate, this.path(row.sha256));
    const directory = await open(join(this.options.root, "blobs"), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    this.metadata.transaction(() => {
      if (existing) this.metadata.adjustStorage(-row.bytes, -1);
      this.metadata.run(
        "INSERT OR IGNORE INTO blobs VALUES(?,?,0)",
        row.sha256,
        JSON.stringify(attachment),
      );
      const reference = this.metadata.get(
        "SELECT sha256 FROM refs WHERE thread=? AND sha256=?",
        row.thread,
        row.sha256,
      );
      if (reference) this.metadata.adjust(row.thread, -row.bytes, -1);
      else {
        this.metadata.run("INSERT INTO refs VALUES(?,?,?)", row.thread, row.sha256, row.name);
        this.metadata.run("UPDATE blobs SET refs=refs+1 WHERE sha256=?", row.sha256);
      }
      this.metadata.run(
        "UPDATE uploads SET done=1,expires=? WHERE id=?",
        this.options.now() + this.limits.ttlMs,
        row.id,
      );
    });
    return attachment;
  }
  private async removeUpload(row: UploadRow): Promise<void> {
    await rm(this.temp(row.id), { force: true });
    this.metadata.transaction(() => {
      this.metadata.run("DELETE FROM uploads WHERE id=?", row.id);
      if (!row.done) {
        this.metadata.adjust(row.thread, -row.bytes, -1);
        this.metadata.adjustStorage(-row.bytes, -1);
      }
    });
    if (
      !row.done &&
      !this.metadata.blob(row.sha256) &&
      !this.metadata.get("SELECT id FROM uploads WHERE sha256=? AND done=0 LIMIT 1", row.sha256)
    )
      await rm(this.path(row.sha256), { force: true });
  }
  async attachment(
    device: string,
    thread: string,
    hash: string,
  ): Promise<{ attachment: Attachment; path: string }> {
    BlobHash.parse(hash);
    return this.serialize(async () => {
      await this.authorized(device, thread);
      const name = this.metadata.get(
        "SELECT name FROM refs WHERE thread=? AND sha256=?",
        thread,
        hash,
      )?.name;
      const blob = this.metadata.blob(hash);
      requireContext(
        name !== undefined && blob,
        "not_found",
        "Thread does not reference attachment",
      );
      return { attachment: Attachment.parse({ ...blob, name }), path: this.path(hash) };
    });
  }
  /** Atomically validate and pin every reference before asynchronous preparation. */
  async acquire(device: string, thread: string, hashes: readonly string[]): Promise<BlobLease> {
    const parsed = z.array(BlobHash).max(64).parse(hashes);
    return this.serialize(async () => {
      await this.authorized(device, thread);
      const blobs = parsed.map((hash) => {
        const name = this.metadata.get(
          "SELECT name FROM refs WHERE thread=? AND sha256=?",
          thread,
          hash,
        )?.name;
        const blob = this.metadata.blob(hash);
        requireContext(
          name !== undefined && blob,
          "not_found",
          "Thread does not reference attachment",
        );
        return { attachment: Attachment.parse({ ...blob, name }), path: this.path(hash) };
      });
      return this.leases.acquire(blobs);
    });
  }
  async releaseThread(thread: string): Promise<void> {
    requireContext(
      thread !== "*" && thread.length <= 128,
      "invalid_request",
      "Invalid thread identifier",
    );
    return this.serialize(async () => {
      for (const attachment of this.list(thread)) this.release(thread, attachment.sha256);
      for (const row of this.metadata.all("SELECT * FROM uploads WHERE thread=?", thread))
        await this.removeUpload(UploadRow.parse(row));
    });
  }
  /** Bounded GC and expiry batch, serialized with commits. */
  async collect(limit = 128): Promise<number> {
    return this.serialize(() => this.maintenance.collect(limit));
  }
  async close(): Promise<void> {
    this.closing = true;
    try {
      await this.tail;
      await this.maintenance.close();
    } finally {
      this.leases.close();
      this.metadata.close();
    }
  }
}
