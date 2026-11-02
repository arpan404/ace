import type { Attachment } from "@ace/protocol";
import { Metadata } from "./metadata.ts";

export interface BlobLease {
  readonly blobs: readonly { attachment: Attachment; path: string }[];
  /** Call after provider consumption, including cancellation and failure. Idempotent. */
  release(): void;
}

/**
 * Process-local leases: a leased file is kept from cleanup while an agent or a transfer still
 * reads it. There is no cap on how many a thread or the daemon holds: a lease is one counter row,
 * and refusing one would refuse the person's message. Shutdown ends every provider's reading.
 */
export class BlobLeases {
  private metadata: Metadata;
  private owners = new Map<string, number>();
  private held = 0;
  private closed = false;
  constructor(metadata: Metadata) {
    this.metadata = metadata;
    metadata.run("CREATE TEMP TABLE leases(sha256 TEXT PRIMARY KEY, count INTEGER NOT NULL)");
  }
  /** Leases currently held, by `owner` or in total. */
  count(owner?: string): number {
    return owner === undefined ? this.held : (this.owners.get(owner) ?? 0);
  }
  acquire(owner: string, blobs: BlobLease["blobs"]): BlobLease {
    if (blobs.length === 0) return { blobs, release() {} };
    const hashes = blobs.map((blob) => blob.attachment.sha256);
    this.metadata.transaction(() => {
      for (const hash of hashes)
        this.metadata.run(
          "INSERT INTO leases VALUES(?,1) ON CONFLICT(sha256) DO UPDATE SET count=count+1",
          hash,
        );
    });
    this.held++;
    this.owners.set(owner, this.count(owner) + 1);
    let released = false;
    const release = () => {
      if (released || this.closed) return;
      released = true;
      this.held--;
      const left = this.count(owner) - 1;
      if (left > 0) this.owners.set(owner, left);
      else this.owners.delete(owner);
      this.metadata.transaction(() => {
        for (const hash of hashes) {
          this.metadata.run("UPDATE leases SET count=count-1 WHERE sha256=?", hash);
          this.metadata.run("DELETE FROM leases WHERE sha256=? AND count=0", hash);
        }
      });
    };
    return { blobs, release };
  }
  close(): void {
    this.closed = true;
  }
}
