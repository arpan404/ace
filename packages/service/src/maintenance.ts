import type { Command } from "@ace/protocol";
/** Admission changes synchronously, before any asynchronous service operation. */
export class MaintenanceGate {
  private draining = false;
  private readonly blockers: () => number;
  private readonly reopened = new Set<() => void>();
  private readonly changed = new Set<(draining: boolean) => void>();
  constructor(blockers: () => number) {
    this.blockers = blockers;
  }
  enter() {
    const was = this.draining;
    this.draining = true;
    if (!was) for (const listener of this.changed) listener(true);
    return this.status();
  }
  leave() {
    const was = this.draining;
    this.draining = false;
    // Work ace deferred while admission was closed (its own resumes) can start now.
    if (was) for (const listener of this.reopened) listener();
    if (was) for (const listener of this.changed) listener(false);
    return this.status();
  }
  /** Calls `listener` each time admission closes or reopens; returns the unsubscribe. */
  onChange(listener: (draining: boolean) => void): () => void {
    this.changed.add(listener);
    return () => this.changed.delete(listener);
  }
  /** Calls `listener` each time admission reopens; returns the unsubscribe. */
  onReopen(listener: () => void): () => void {
    this.reopened.add(listener);
    return () => this.reopened.delete(listener);
  }
  status() {
    return { draining: this.draining, blockers: this.blockers() };
  }
  admitCommand(command: Command): boolean {
    if (this.admit()) return true;
    switch (command.payload.type) {
      case "diagnostics.health":
      case "interaction.resolve":
      case "thread.interrupt":
      case "background_task.stop":
      case "orchestration.cancel":
        return true;
      default:
        return false;
    }
  }
  admit(): boolean {
    return !this.draining;
  }
}
