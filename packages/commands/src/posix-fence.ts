import type { Job } from "./posix-lane-types.ts";
import { isChange } from "./posix-ops.ts";

/**
 * Files and folders, by identity (dev and ino), that a change may still be landing in: one that
 * timed out, or was given up while running. Different anchors (lanes) can reach the same folder,
 * so this is shared by every lane, not kept per root.
 */
export class ChangeFence {
  private readonly landing = new Map<string, number>();

  /** Whether a change to `identities` could race one that may still land. */
  blocks(identities: readonly string[]): boolean {
    return identities.some((identity) => this.landing.has(identity));
  }
  /** A change that may still land keeps what it changes off limits to other changes. */
  hold(job: Job): void {
    if (job.holding || !isChange(job.operation)) return;
    job.holding = true;
    for (const identity of job.identities)
      this.landing.set(identity, (this.landing.get(identity) ?? 0) + 1);
  }
  /** The change has returned natively, or its thread has exited: it can't land any more. */
  landed(job: Job): void {
    if (!job.holding) return;
    job.holding = false;
    for (const identity of job.identities) {
      const left = (this.landing.get(identity) ?? 1) - 1;
      if (left > 0) this.landing.set(identity, left);
      else this.landing.delete(identity);
    }
  }
}
