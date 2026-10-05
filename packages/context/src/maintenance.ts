import { mediaExtension } from "./attachment-bytes.ts";
import { opendir, rm } from "node:fs/promises";
import { join } from "node:path";
import { BlobHash } from "@ace/protocol";
import { requireContext } from "./errors.ts";
import { Metadata, UploadRow } from "./metadata.ts";

export class Maintenance {
  private metadata: Metadata;
  private root: string;
  private now: () => number;
  private removeUpload: (row: UploadRow) => Promise<void>;
  private directory: Awaited<ReturnType<typeof opendir>> | undefined;
  private uploadDirectory: Awaited<ReturnType<typeof opendir>> | undefined;
  constructor(
    metadata: Metadata,
    root: string,
    now: () => number,
    removeUpload: (row: UploadRow) => Promise<void>,
  ) {
    this.metadata = metadata;
    this.root = root;
    this.now = now;
    this.removeUpload = removeUpload;
  }
  /** Bounded maintenance tick; retained directory cursor makes orphan reconciliation incremental. */
  async collect(limit: number): Promise<number> {
    requireContext(
      Number.isInteger(limit) && limit > 0 && limit <= 1024,
      "invalid_request",
      "Invalid GC batch limit",
    );

    let removed = 0;
    for (const value of this.metadata.all(
      "SELECT * FROM uploads WHERE expires<=? ORDER BY expires LIMIT ?",
      this.now(),
      limit,
    ))
      await this.removeUpload(UploadRow.parse(value));
    for (const row of this.metadata.all(
      "SELECT sha256 FROM blobs WHERE refs=0 AND NOT EXISTS(SELECT 1 FROM leases WHERE leases.sha256=blobs.sha256) AND NOT EXISTS(SELECT 1 FROM uploads WHERE uploads.sha256=blobs.sha256 AND done=0) LIMIT ?",
      limit,
    )) {
      const hash = BlobHash.parse(row.sha256);
      const blob = this.metadata.blob(hash);
      await rm(join(this.root, "blobs", hash), { force: true });
      if (blob && mediaExtension(blob.mimeType))
        await rm(join(this.root, "blobs", hash + mediaExtension(blob.mimeType)), { force: true });
      this.metadata.transaction(() => {
        this.metadata.run("DELETE FROM blobs WHERE sha256=? AND refs=0", hash);
        if (blob) this.metadata.adjustStorage(-blob.bytes, -1);
      });
      removed++;
    }
    this.uploadDirectory ??= await opendir(join(this.root, "uploads"));
    for (let i = 0; i < limit; i++) {
      const entry = await this.uploadDirectory.read();
      if (!entry) {
        await this.uploadDirectory.close();
        this.uploadDirectory = undefined;
        break;
      }
      if (
        entry.isFile() &&
        /^[\w-]{1,128}$/.test(entry.name) &&
        !this.metadata.upload(entry.name)
      ) {
        await rm(join(this.root, "uploads", entry.name));
      }
    }
    this.directory ??= await opendir(join(this.root, "blobs"));
    for (let i = 0; i < limit; i++) {
      const entry = await this.directory.read();
      if (!entry) {
        await this.directory.close();
        this.directory = undefined;
        break;
      }
      if (
        entry.isFile() &&
        BlobHash.safeParse(entry.name.split(".")[0]).success &&
        !this.metadata.blob(entry.name.split(".")[0] ?? "") &&
        !this.metadata.get(
          "SELECT id FROM uploads WHERE sha256=? AND done=0 LIMIT 1",
          entry.name.split(".")[0] ?? "",
        )
      ) {
        await rm(join(this.root, "blobs", entry.name));
        removed++;
      }
    }
    return removed;
  }
  async close(): Promise<void> {
    await this.uploadDirectory?.close();
    this.uploadDirectory = undefined;
    await this.directory?.close();
    this.directory = undefined;
  }
}
