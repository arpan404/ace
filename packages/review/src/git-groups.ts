import {
  registerGroup,
  reportedGroup,
  signalSoon,
  stopRetainedGroup,
  unregisterGroup,
  type LeaderGroup,
} from "@ace/provider-kit/process";

/** The parent retains Git groups even if their spawning isolate dies abruptly. */
export class ReviewGitGroups {
  private readonly groups = new Map<number, LeaderGroup>();
  /**
   * `start` is the Git child's kernel start, read by the isolate right after its spawn. Its group
   * is signalled by number only while that process still holds the pid; without a start it is
   * never signalled from here, only by the isolate that spawned it.
   */
  update(pid: number, active: boolean, start?: string): void {
    if (!active) {
      if (this.groups.delete(pid)) unregisterGroup(pid);
      return;
    }
    if (!this.groups.has(pid) && this.groups.size >= 64) throw new Error("Review Git group limit");
    if (start === undefined) return;
    const group = reportedGroup({ pid, start });
    try {
      registerGroup(
        pid,
        (graceMs) => stopRetainedGroup(group, graceMs),
        { name: "ace-process" },
        () => signalSoon(group, "SIGKILL"),
      );
    } catch {
      // The report crosses threads, so a quick Git child may already have exited: macOS then
      // has no identity for its zombie and the journal refuses it. registerGroup has ended the
      // group, so nothing runs unowned; the isolate and its other requests carry on.
      return;
    }
    this.groups.set(pid, group);
  }
  async close(): Promise<void> {
    // Called only after isolate exit, when no more groups can be published.
    const results = await Promise.allSettled(
      [...this.groups.values()].map((group) => stopRetainedGroup(group, 1000)),
    );
    this.groups.clear();
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
}
