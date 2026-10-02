import type { Command } from "@ace/protocol";
/** Admission changes synchronously, before any asynchronous service operation. */
export class MaintenanceGate {
  private draining = false;
  private readonly blockers: () => number;
  constructor(blockers: () => number) {
    this.blockers = blockers;
  }
  enter() {
    this.draining = true;
    return this.status();
  }
  leave() {
    this.draining = false;
    return this.status();
  }
  status() {
    return { draining: this.draining, blockers: this.blockers() };
  }
  admitCommand(command: Command): boolean {
    if (this.admit()) return true;
    switch (command.payload.type) {
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
