import { fchmod, fsync } from "node:fs";
import { lstat } from "node:fs/promises";
import { SafeRoot } from "@ace/workspace";
import { Catalog, type UploadRecord, type UploadReceipt } from "./catalog.ts";
import { hashFile } from "./filesystem.ts";
import { FileError, version } from "./types.ts";

/** Durable intent belongs to the catalog; only the known published inode can discharge it. */
export class UploadPublication {
  constructor(privateSafe: SafeRoot, privateCatalog: Catalog, privateNow: () => number) {
    this.safe = privateSafe;
    this.catalog = privateCatalog;
    this.now = privateNow;
  }
  private readonly safe: SafeRoot;
  private readonly catalog: Catalog;
  private readonly now: () => number;
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
    const target = await this.safe.target(receipt.path);
    const { info } = await this.safe.metadata(receipt.path);
    if (!info.isFile() || `${info.dev}:${info.ino}` !== pending.identity)
      throw new FileError("CONFLICT", "Published upload was replaced before permissions settled");
    if ((info.mode & 0o777) !== pending.mode) {
      const { handle, info: opened } = await this.safe.file(receipt.path);
      try {
        if (`${opened.dev}:${opened.ino}` !== pending.identity)
          throw new FileError("CONFLICT", "Published upload changed");
        await new Promise<void>((resolve, reject) =>
          fchmod(handle.fd, pending.mode, (error) => (error ? reject(error) : resolve())),
        );
        await new Promise<void>((resolve, reject) =>
          fsync(handle.fd, (error) => (error ? reject(error) : resolve())),
        );
        await target.verify();
        if (version(await lstat(target.path)) !== version(await handle.stat()))
          throw new FileError("CONFLICT", "Published upload changed");
      } finally {
        await handle.close();
      }
    }
    const settled = { ...receipt };
    delete settled.permissions;
    this.catalog.finishUploadPermissions(settled);
  }
  async recover(record: UploadRecord): Promise<UploadReceipt | undefined> {
    if (!record.publishing) return;
    let verified = false;
    try {
      const target = await this.safe.target(record.path);
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
