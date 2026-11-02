import type { Attachment } from "@ace/protocol";
import { Metadata } from "./metadata.ts";
import { requireContext } from "./errors.ts";

export interface BlobLease {
  readonly blobs: readonly { attachment: Attachment; path: string }[];
  /** Call after provider consumption, including cancellation and failure. Idempotent. */
  release(): void;
}
export interface BlobLeaseOptions {
  now(): number;
  /** False once the owning thread (or draft) is gone: its leases can be reclaimed. */
  ownerAlive?(owner: string): boolean;
  /**
   * Leases one thread may hold. The engine holds a message's lease until the run that read it
   * ends, and caps one thread at 256 delivered inputs; reads and downloads hold theirs for one
   * transfer and are capped per connection. So 256 covers a long turn that takes many screenshots.
   */
  perOwner?: number;
  /** Leases across every thread: only a guard against a leak, each lease is one temp row. */
  total?: number;
  /** Under pressure, a lease this old is presumed orphaned and reclaimed, oldest first. */
  staleMs?: number;
}
type Held = { owner: string; at: number; release(): void };

/**
 * Process-local leases: shutdown ends the provider consumption lifetime. Bounds are per thread,
 * so one busy thread can never block another, and a full bound heals itself by reclaiming
 * leases whose thread is gone or that outlived any real read.
 */
export class BlobLeases {
  private metadata: Metadata;
  private options: Required<Omit<BlobLeaseOptions, "ownerAlive">> &
    Pick<BlobLeaseOptions, "ownerAlive">;
  /** Insertion order is acquisition order, so the first entries are the oldest. */
  private held = new Map<number, Held>();
  private owners = new Map<string, number>();
  private sequence = 0;
  private closed = false;
  constructor(metadata: Metadata, options: BlobLeaseOptions) {
    this.metadata = metadata;
    this.options = {
      perOwner: 256,
      total: 4096,
      staleMs: 60 * 60 * 1000,
      ...options,
    };
    metadata.run("CREATE TEMP TABLE leases(sha256 TEXT PRIMARY KEY, count INTEGER NOT NULL)");
  }
  /** Leases currently held, by `owner` or in total. */
  count(owner?: string): number {
    return owner === undefined ? this.held.size : (this.owners.get(owner) ?? 0);
  }
  acquire(owner: string, blobs: BlobLease["blobs"]): BlobLease {
    if (blobs.length === 0) return { blobs, release() {} };
    const hashes = blobs.map((blob) => blob.attachment.sha256);
    this.makeRoom(owner);
    requireContext(
      this.count(owner) < this.options.perOwner,
      "busy",
      "This thread's agents are still reading too many earlier attachments. Wait for the current turn to finish, or stop it, then send again.",
    );
    requireContext(
      this.held.size < this.options.total,
      "busy",
      "Agents across your threads are still reading too many attachments. Wait for running turns to finish, or stop some, then send again.",
    );
    this.metadata.transaction(() => {
      for (const hash of hashes)
        this.metadata.run(
          "INSERT INTO leases VALUES(?,1) ON CONFLICT(sha256) DO UPDATE SET count=count+1",
          hash,
        );
    });
    const id = ++this.sequence;
    let released = false;
    const release = () => {
      if (released || this.closed) return;
      released = true;
      this.held.delete(id);
      const left = (this.owners.get(owner) ?? 1) - 1;
      if (left > 0) this.owners.set(owner, left);
      else this.owners.delete(owner);
      this.metadata.transaction(() => {
        for (const hash of hashes) {
          this.metadata.run("UPDATE leases SET count=count-1 WHERE sha256=?", hash);
          this.metadata.run("DELETE FROM leases WHERE sha256=? AND count=0", hash);
        }
      });
    };
    this.held.set(id, { owner, at: this.options.now(), release });
    this.owners.set(owner, this.count(owner) + 1);
    return { blobs, release };
  }
  /**
   * At a bound, release what can no longer be read: leases of threads that are gone, then
   * leases older than `staleMs`, oldest first, until there is room. A live recent lease is
   * never taken. Releasing is idempotent, so a holder's own later release is harmless.
   */
  private makeRoom(owner: string): void {
    const full = () =>
      this.count(owner) >= this.options.perOwner || this.held.size >= this.options.total;
    if (!full()) return;
    const alive = this.options.ownerAlive;
    if (alive) {
      const gone = new Map<string, boolean>();
      for (const lease of [...this.held.values()]) {
        let dead = gone.get(lease.owner);
        if (dead === undefined) gone.set(lease.owner, (dead = !alive(lease.owner)));
        if (dead) lease.release();
      }
    }
    const cutoff = this.options.now() - this.options.staleMs;
    for (const lease of [...this.held.values()]) {
      if (!full() || lease.at > cutoff) return;
      // Room for this owner comes from its own leases; room in total from anyone's.
      if (this.held.size >= this.options.total || lease.owner === owner) lease.release();
    }
  }
  close(): void {
    this.closed = true;
  }
}
