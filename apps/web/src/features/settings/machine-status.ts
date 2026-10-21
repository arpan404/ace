import type { MachineStatus } from "@/lib/machines.ts";

const words: Record<MachineStatus, string> = {
  online: "Connected",
  connecting: "Connecting",
  offline: "Offline",
  auth_failed: "Access refused",
};

/** A machine's connection in one word, as Settings shows it. */
export function machineStatusWord(machine: { status: MachineStatus }): string {
  return words[machine.status];
}
