import { browserOrigin } from "./policy.ts";
import type { NavigationTask } from "./navigation.ts";

/** A click can start an approval before the agent submits its page wait. */
export class NavigationPolicies {
  task: NavigationTask | undefined;
  private pending = new Set<{ origin: string | undefined; resume: (() => void) | undefined }>();
  start(task: NavigationTask): void {
    this.task = task;
    for (const entry of this.pending) {
      entry.resume?.();
      entry.resume = task.pause();
      task.policyOrigin = entry.origin;
    }
  }
  finish(task: NavigationTask): void {
    if (this.task !== task) return;
    for (const entry of this.pending) {
      entry.resume?.();
      entry.resume = undefined;
    }
    this.task = undefined;
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
