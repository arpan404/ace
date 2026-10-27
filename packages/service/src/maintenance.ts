import type { Command, MaintenanceHold } from "@ace/protocol";

export type { MaintenanceHold };

/**
 * Admission for new work (ADR 0041), closed while anything holds it: the person's pause
 * (`user`), an app update draining work (`update`), kill-all's fence (`kill`) or a stop
 * (`stop`). Each owner adds and removes only its own hold, so one can never reopen admission
 * another still needs. Admission changes synchronously, before any asynchronous operation.
 */
export class MaintenanceGate {
  private readonly holds = new Set<MaintenanceHold>();
  private readonly blockers: () => number;
  private readonly waiting: () => number;
  private readonly reopened = new Set<() => void>();
  private readonly changed = new Set<() => void>();
  /**
   * `blockers` counts threads still at work or waiting; `waiting` how many of those wait on a
   * person, so a paused machine can tell them apart.
   */
  constructor(blockers: () => number, waiting: () => number = () => 0) {
    this.blockers = blockers;
    this.waiting = waiting;
  }
  /** Adds `hold`; admission closes if it was open. */
  enter(hold: MaintenanceHold = "user") {
    if (!this.holds.has(hold)) {
      this.holds.add(hold);
      for (const listener of this.changed) listener();
    }
    return this.status();
  }
  /** Removes only `hold`; admission reopens once no hold is left. */
  leave(hold: MaintenanceHold = "user") {
    if (this.holds.delete(hold)) {
      // Work ace deferred while admission was closed (its own resumes) can start now.
      if (!this.holds.size) for (const listener of this.reopened) listener();
      for (const listener of this.changed) listener();
    }
    return this.status();
  }
  held(hold: MaintenanceHold): boolean {
    return this.holds.has(hold);
  }
  /** Calls `listener` each time a hold is added or removed; returns the unsubscribe. */
  onChange(listener: () => void): () => void {
    this.changed.add(listener);
    return () => this.changed.delete(listener);
  }
  /** Calls `listener` each time admission reopens; returns the unsubscribe. */
  onReopen(listener: () => void): () => void {
    this.reopened.add(listener);
    return () => this.reopened.delete(listener);
  }
  status() {
    const blockers = this.blockers();
    return {
      draining: this.holds.size > 0,
      blockers,
      waiting: Math.min(this.waiting(), blockers),
      holds: [...this.holds].toSorted(),
    };
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
    return this.holds.size === 0;
  }
}
