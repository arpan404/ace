import { lstat } from "node:fs/promises";
import { SafeRoot } from "@ace/workspace";
import { Catalog, type UploadRecord, type UploadReceipt } from "./catalog.ts";
import { hashFile } from "./filesystem.ts";
import { codeOf, version, type FilesOptions } from "./types.ts";

/** Durable intent belongs to the catalog; only the known published inode can discharge it. */
export class UploadPublication {
  constructor(
    privateSafe: SafeRoot,
    privateCatalog: Catalog,
    privateNow: () => number,
    report?: FilesOptions["onUploadRecovery"],
  ) {
    this.safe = privateSafe;
    this.catalog = privateCatalog;
    this.now = privateNow;
    this.report = report;
  }
  private readonly safe: SafeRoot;
  private readonly catalog: Catalog;
  private readonly now: () => number;
  private readonly report: FilesOptions["onUploadRecovery"];
  complete(record: UploadRecord, sha256: string): UploadReceipt {
    const receipt: UploadReceipt = {
      id: record.id,
      kind: "upload.completed",
      bytes: 0,
      device: record.device,
      path: record.path,
      ...(record.mode === undefined
        ? {}
        : { permissions: { identity: record.identity, mode: record.mode } }),
      sha256,
      expires: Math.max(record.expires, this.now() + 86400_000),
    };
    this.catalog.completeUpload(receipt);
    return receipt;
  }
  async finishPermissions(receipt: UploadReceipt): Promise<void> {
    const pending = receipt.permissions;
    if (!pending) return;
    let reason: string | undefined;
    try {
      await this.safe.target(receipt.path);
      const { info, type } = await this.safe.metadata(receipt.path);
      if (
        type !== "file" ||
        `${info.dev}:${info.ino}` !== pending.identity ||
        (info.mode & 0o777) !== pending.mode
      )
        reason = "destination_changed";
    } catch (error) {
      reason = codeOf(error);
    }
    // Permissions were set before publication. A completed receipt no longer owns
    // the path: moved, missing or externally changed files are never modified.
    const settled = { ...receipt };
    delete settled.permissions;
    this.catalog.finishUploadPermissions(settled);
    if (reason) this.report?.({ uploadId: receipt.id, path: receipt.path, reason });
  }
  async recover(record: UploadRecord): Promise<UploadReceipt | undefined> {
    if (!record.publishing) return;
    let verified = false;
    try {
      const target = await this.safe.target(record.path);
      if (record.verified) {
        const { info } = await this.safe.metadata(record.path);
        const current = await lstat(target.path);
        if (
          !current.isFile() ||
          `${current.dev}:${current.ino}` !== record.identity ||
          current.dev !== info.dev ||
          current.ino !== info.ino ||
          current.size !== record.bytes ||
          current.mtimeMs !== record.verified.mtimeMs ||
          current.birthtimeMs !== record.verified.birthtimeMs ||
          (current.mode & 0o777) !== record.verified.mode
        )
          return;
        // Rename may change ctime. Identity, content mtime, birthtime, size and
        // permissions attest to the inode hashed before publication without opening it.
        await target.verify();
        if (version(await lstat(target.path)) !== version(current)) return;
        verified = true;
      } else {
        // Compatibility for durable intents written before metadata attestation.
        const { handle, info } = await this.safe.file(record.path);
        try {
          if (`${info.dev}:${info.ino}` !== record.identity || info.size !== record.bytes) return;
          const before = version(info);
          if ((await hashFile(handle)) !== record.publishing) return;
          if (version(await handle.stat()) !== before) return;
          await target.verify();
          if (version(await lstat(target.path)) !== before) return;
          verified = true;
        } finally {
          await handle.close();
        }
      }
    } catch {
      // Inaccessible, missing or replaced destinations retain their reservation.
      return;
    }
    if (verified) {
      const receipt = this.complete(record, record.publishing);
      await this.finishPermissions(receipt);
      return receipt;
    }
  }
}
