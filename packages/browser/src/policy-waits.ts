import { browserOrigin } from "./policy.ts";
import type { NavigationTask } from "./navigation.ts";

/** A click can start an approval before the agent submits its page wait. */
export class NavigationPolicies {
  task: NavigationTask | undefined;
  /** Every navigation and page wait in flight, on any tab. */
  private live = new Set<NavigationTask>();
  private pending = new Set<{ origin: string | undefined; resume: (() => void) | undefined }>();
  start(task: NavigationTask): void {
    this.task = task;
    this.live.add(task);
    for (const entry of this.pending) {
      entry.resume?.();
      entry.resume = task.pause();
      task.policyOrigin = entry.origin;
    }
  }
  finish(task: NavigationTask): void {
    this.live.delete(task);
    if (this.task !== task) return;
    for (const entry of this.pending) {
      entry.resume?.();
      entry.resume = undefined;
    }
    this.task = undefined;
  }
  /** After sleep: every navigation in flight gets its remaining time again. */
  wake(): void {
    for (const task of this.live) task.rearm();
  }
  wait(url: string): () => void {
    const entry = { origin: browserOrigin(url), resume: this.task?.pause() };
    this.pending.add(entry);
    if (this.task) this.task.policyOrigin = entry.origin;
    return () => {
      this.pending.delete(entry);
      entry.resume?.();
      if (this.task) this.task.policyOrigin = [...this.pending].at(-1)?.origin;
    };
  }
}
