import { hasThumbnail } from "./attachment-bytes.ts";
import { beginUpload } from "./upload-admission.ts";
import { BlobLeases, type BlobLease } from "./blob-leases.ts";
import { constants } from "node:fs";
import { chmod, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  ThreadId,
  Attachment,
  BlobHash,
  ContextOperation,
  type ContextResult,
} from "@ace/protocol";
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
  private collectionThread = "";
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
    if (this.metadata.get("SELECT 1 FROM drafts WHERE id=?", thread)) {
      await this.draftWorkspace(device, thread);
      return;
    }
    requireContext(
      thread !== "*" &&
        thread.length <= 128 &&
        device.length <= 128 &&
        (await this.options.authorize(device, thread)),
      "forbidden",
      "Thread access denied",
    );
  }
  async draftWorkspace(device: string, id: string): Promise<string> {
    const row = this.metadata.get("SELECT * FROM drafts WHERE id=?", id);
    const draft = z
      .object({
        device: z.string(),
        workspace: z.string(),
        expires: z.number(),
        adopted: z.string().nullable(),
      })
      .safeParse(row);
    requireContext(
      draft.success && draft.data.device === device && draft.data.expires > this.options.now(),
      "not_found",
      "Draft unavailable",
    );
    return draft.data.workspace;
  }
  async adopt(device: string, draftId: string, thread: string): Promise<void> {
    return this.serialize(async () => {
      await this.authorized(device, thread);
      const workspace = await this.draftWorkspace(device, draftId);
      requireContext(
        workspace === (await this.options.threadWorkspace?.(thread)),
        "forbidden",
        "Draft belongs to another workspace",
      );
      const row = this.metadata.get("SELECT adopted FROM drafts WHERE id=?", draftId);
      if (row?.adopted === thread) return;
      requireContext(row?.adopted === null, "forbidden", "Draft already adopted");
      const source = this.metadata.usage(draftId);
      const target = this.metadata.usage(thread);
      requireContext(
        source.bytes + target.bytes <= this.limits.threadBytes &&
          source.count + target.count <= this.limits.threadEntries,
        "quota",
        "Thread quota exceeded",
      );
      requireContext(
        !this.metadata.get("SELECT 1 FROM uploads WHERE thread=? AND done=0 LIMIT 1", draftId),
        "busy",
        "Finish uploads before creating the thread",
      );
      this.metadata.transaction(() => {
        for (const attachment of this.list(draftId)) {
          if (
            !this.metadata.get(
              "SELECT 1 FROM refs WHERE thread=? AND sha256=?",
              thread,
              attachment.sha256,
            )
          ) {
            this.metadata.run(
              "INSERT INTO refs VALUES(?,?,?)",
              thread,
              attachment.sha256,
              attachment.name,
            );
            this.metadata.run("UPDATE blobs SET refs=refs+1 WHERE sha256=?", attachment.sha256);
            this.metadata.adjust(thread, attachment.bytes, 1);
          }
          this.removeReference(draftId, attachment.sha256);
        }
        this.metadata.run("UPDATE drafts SET adopted=? WHERE id=?", thread, draftId);
      });
    });
  }
  async handle(
    device: string,
    value: unknown,
    access: (thread?: string) => boolean = () => true,
  ): Promise<Result> {
    const op = ContextOperation.parse(value);
    return this.serialize(async () => {
      requireContext(access(), "forbidden", "Device access revoked");
      if (op.op === "draft.create") {
        const workspace = await this.options.workspace?.(op.workspaceId);
        requireContext(workspace, "not_found", "Workspace unavailable");
        requireContext(
          Number(this.metadata.get("SELECT COUNT(*) AS n FROM drafts")?.n) < 1024,
          "quota",
          "Draft capacity reached",
        );
        const draftId = `draft-${this.options.id()}`;
        z.string()
          .regex(/^[\w-]{1,128}$/)
          .parse(draftId);
        this.metadata.run(
          "INSERT INTO drafts VALUES(?,?,?,?,NULL)",
          draftId,
          device,
          workspace,
          this.options.now() + this.limits.ttlMs,
        );
        return { kind: "draft", draftId };
      }
      if (op.op === "draft.release") {
        await this.draftWorkspace(device, op.draftId);
        for (const attachment of this.list(op.draftId)) this.release(op.draftId, attachment.sha256);
        for (const row of this.metadata.all("SELECT * FROM uploads WHERE thread=?", op.draftId))
          await this.removeUpload(UploadRow.parse(row));
        this.metadata.run("DELETE FROM drafts WHERE id=?", op.draftId);
        return { kind: "ok" };
      }
      if (op.op === "draft.upload.begin") {
        await this.draftWorkspace(device, op.draftId);
        requireContext(
          this.metadata.get("SELECT adopted FROM drafts WHERE id=?", op.draftId)?.adopted === null,
          "forbidden",
          "Draft already adopted",
        );
        return beginUpload(this.metadata, this.options, this.limits, device, {
          ...op,
          op: "upload.begin",
          threadId: ThreadId.parse(op.draftId),
        });
      }
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
      requireContext(
        access(
          this.metadata.get("SELECT 1 FROM drafts WHERE id=?", row.thread) ? undefined : row.thread,
        ),
        "forbidden",
        "Thread attachment permission revoked",
      );
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
    this.metadata.transaction(() => this.removeReference(thread, hash));
  }
  /** The caller owns the transaction, including both sides of draft adoption. */
  private removeReference(thread: string, hash: string): void {
    requireContext(
      !this.options.retained?.(thread, hash),
      "busy",
      "Attachment is referenced by queued or unacknowledged work",
    );
    const existing = this.metadata.get(
      "SELECT sha256 FROM refs WHERE thread=? AND sha256=?",
      thread,
      hash,
    );
    const blob = this.metadata.blob(hash);
    if (!existing || !blob) return;
    this.metadata.run("DELETE FROM refs WHERE thread=? AND sha256=?", thread, hash);
    this.metadata.run("UPDATE blobs SET refs=refs-1 WHERE sha256=?", hash);
    this.metadata.adjust(thread, -blob.bytes, -1);
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
        file = await open(candidate, "r");
      }
      try {
        if (candidate === this.temp(row.id)) {
          await file.truncate(row.offset);
          await file.sync();
        }
      } finally {
        await file.close();
      }
      const inspected = await inspectBlob(
        candidate,
        this.options.imageLimits ?? defaultImageLimits,
        row.name,
        row.mime_type ?? undefined,
      );
      requireContext(
        inspected.sha256 === row.sha256 && inspected.bytes === row.bytes,
        "hash_mismatch",
        "Upload hash does not match declared sha256",
      );
      attachment = Attachment.parse({
        ...inspected,
        name: row.name,
        thumbnailAvailable: inspected.kind === "image" && hasThumbnail(inspected.mimeType),
      });
    } catch (error) {
      await this.removeUpload(row);
      if (error instanceof ContextError) throw error;
      throw new ContextError("invalid_image", "Image header could not be validated");
    }
    const existing = this.metadata.blob(row.sha256);
    // Publish the verified bytes even when metadata exists. A crash during GC can
    // leave an unreferenced metadata row whose file has already been removed.
    if (candidate !== this.path(row.sha256)) {
      const retained =
        existing &&
        (await stat(this.path(row.sha256)).catch((error: unknown) => {
          if (error instanceof Error && "code" in error && error.code === "ENOENT")
            return undefined;
          throw error;
        }));
      if (retained?.isFile() && retained.size === row.bytes) await rm(candidate);
      else await rename(candidate, this.path(row.sha256));
    }
    await chmod(this.path(row.sha256), 0o400);
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
  async acquireMessage(
    device: string,
    thread: string,
    hashes: readonly string[],
  ): Promise<BlobLease> {
    const lease = await this.acquire(device, thread, hashes);
    try {
      requireContext(
        lease.blobs.reduce((sum, blob) => sum + blob.attachment.bytes, 0) <=
          this.limits.messageBytes,
        "quota",
        `Attachments exceed the ${this.limits.messageBytes} byte message limit. Remove files or send them in separate messages.`,
      );
      return lease;
    } catch (error) {
      lease.release();
      throw error;
    }
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
    return this.serialize(async () => {
      requireContext(
        Number.isInteger(limit) && limit > 0 && limit <= 1024,
        "invalid_request",
        "Invalid GC batch limit",
      );
      if (this.options.threadExists) {
        const owners = this.metadata.all(
          "SELECT DISTINCT thread FROM refs WHERE thread>? ORDER BY thread LIMIT ?",
          this.collectionThread,
          limit,
        );
        for (const owner of owners) {
          const thread = z.string().parse(owner.thread);
          this.collectionThread = thread;
          if (
            !this.metadata.get("SELECT 1 FROM drafts WHERE id=?", thread) &&
            !this.options.threadExists(thread)
          ) {
            for (const attachment of this.list(thread))
              this.removeReference(thread, attachment.sha256);
            for (const row of this.metadata.all("SELECT * FROM uploads WHERE thread=?", thread))
              await this.removeUpload(UploadRow.parse(row));
          }
        }
        if (owners.length < limit) this.collectionThread = "";
      }
      const expired = this.metadata.all(
        "SELECT id FROM drafts WHERE expires<=? ORDER BY expires LIMIT ?",
        this.options.now(),
        limit,
      );
      for (const row of expired) {
        const id = z.string().parse(row.id);
        for (const attachment of this.list(id)) this.release(id, attachment.sha256);
        for (const upload of this.metadata.all("SELECT * FROM uploads WHERE thread=?", id))
          await this.removeUpload(UploadRow.parse(upload));
        this.metadata.run("DELETE FROM drafts WHERE id=?", id);
      }
      return expired.length + (await this.maintenance.collect(limit));
    });
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
