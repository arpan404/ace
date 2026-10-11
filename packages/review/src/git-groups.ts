import { registerGroup, unregisterGroup, stopRetainedGroup } from "@ace/provider-kit/process";

/** The parent retains Git groups even if their spawning isolate dies abruptly. */
export class ReviewGitGroups {
  private readonly groups = new Set<number>();
  update(pid: number, active: boolean): void {
    if (!active) {
      if (this.groups.delete(pid)) unregisterGroup(pid);
      return;
    }
    if (!this.groups.has(pid) && this.groups.size >= 64) throw new Error("Review Git group limit");
    this.groups.add(pid);
    registerGroup(pid, (graceMs) => stopRetainedGroup(pid, graceMs));
  }
  async close(): Promise<void> {
    // Called only after isolate exit, when no more groups can be published.
    const results = await Promise.allSettled(
      [...this.groups].map((pid) => stopRetainedGroup(pid, 1000)),
    );
    this.groups.clear();
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
}
