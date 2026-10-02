import type { Attachment } from "@ace/protocol";
import { Metadata } from "./metadata.ts";
import { requireContext } from "./errors.ts";

export interface BlobLease {
  readonly blobs: readonly { attachment: Attachment; path: string }[];
  /** Call after provider consumption, including cancellation and failure. Idempotent. */
  release(): void;
}
/** Process-local leases: shutdown ends the provider consumption lifetime. */
export class BlobLeases {
  private metadata: Metadata;
  private active = 0;
  private closed = false;
  constructor(metadata: Metadata) {
    this.metadata = metadata;
    metadata.run("CREATE TEMP TABLE leases(sha256 TEXT PRIMARY KEY, count INTEGER NOT NULL)");
  }
  acquire(blobs: BlobLease["blobs"]): BlobLease {
    if (blobs.length === 0) return { blobs, release() {} };
    const hashes = blobs.map((blob) => blob.attachment.sha256);
    requireContext(this.active < 128, "busy", "Attachment lease limit reached");
    this.metadata.transaction(() => {
      for (const hash of hashes)
        this.metadata.run(
          "INSERT INTO leases VALUES(?,1) ON CONFLICT(sha256) DO UPDATE SET count=count+1",
          hash,
        );
    });
    this.active++;
    let released = false;
    return {
      blobs,
      release: () => {
        if (released || this.closed) return;
        released = true;
        this.metadata.transaction(() => {
          for (const hash of hashes) {
            this.metadata.run("UPDATE leases SET count=count-1 WHERE sha256=?", hash);
            this.metadata.run("DELETE FROM leases WHERE sha256=? AND count=0", hash);
          }
        });
        this.active--;
      },
    };
  }
  close(): void {
    this.closed = true;
  }
}
