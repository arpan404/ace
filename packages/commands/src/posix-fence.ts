import type { Job } from "./posix-lane-types.ts";
import { isChange } from "./posix-ops.ts";

/**
 * Files and folders, by identity (dev and ino), that a change may still be landing in: one that
 * timed out, or was given up while running. Different anchors (lanes) can reach the same folder,
 * so this is shared by every lane, not kept per root.
 */
export class ChangeFence {
  private readonly landing = new Map<string, number>();
  /** Holds by the root of the call holding them, and who waits for each root to clear. */
  private readonly roots = new Map<string, number>();
  private readonly waiters = new Map<string, (() => void)[]>();

  /** Whether a change to `identities` could race one that may still land. */
  blocks(identities: readonly string[]): boolean {
    return identities.some((identity) => this.landing.has(identity));
  }
  /** A change that may still land keeps what it changes off limits to other changes. */
  hold(job: Job): void {
    if (job.holding || !isChange(job.operation)) return;
    job.holding = true;
    this.roots.set(job.root, (this.roots.get(job.root) ?? 0) + 1);
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
    const held = (this.roots.get(job.root) ?? 1) - 1;
    if (held > 0) return void this.roots.set(job.root, held);
    this.roots.delete(job.root);
    for (const resolve of this.waiters.get(job.root) ?? []) resolve();
    this.waiters.delete(job.root);
  }
  /** Resolves once no change made under `root` holds anything as landing. */
  clear(root: string): Promise<void> {
    if (!this.roots.has(root)) return Promise.resolve();
    return new Promise((resolve) => {
      const list = this.waiters.get(root) ?? [];
      list.push(resolve);
      this.waiters.set(root, list);
    });
  }
  holds(root: string): boolean {
    return this.roots.has(root);
  }
}
