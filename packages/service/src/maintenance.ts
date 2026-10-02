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
    return (
      this.admit() ||
      ["interaction.resolve", "thread.interrupt", "background_task.stop"].includes(
        command.payload.type,
      )
    );
  }
  admit(): boolean {
    return !this.draining;
  }
}
