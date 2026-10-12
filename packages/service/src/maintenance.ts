import type { Command } from "@ace/protocol";
/** Admission changes synchronously, before any asynchronous service operation. */
export class MaintenanceGate {
  private draining = false;
  private storageLeases = 0;
  private readonly blockers: () => number;
  constructor(blockers: () => number) {
    this.blockers = blockers;
  }
  storageLease(): () => void {
    this.storageLeases++;
    let held = true;
    return () => {
      if (held) {
        held = false;
        this.storageLeases--;
      }
    };
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
    return { draining: this.draining || this.storageLeases > 0, blockers: this.blockers() };
  }
  admitCommand(command: Command): boolean {
    if (this.storageLeases > 0) return command.payload.type === "diagnostics.health";
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
    return !this.draining && this.storageLeases === 0;
  }
}
