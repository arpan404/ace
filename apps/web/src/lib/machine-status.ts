import type { MachineStatus } from "./machines.ts";
import type { Tone } from "@ace/ui-core";

export const machineStatus: Record<MachineStatus, { label: string; tone: Tone }> = {
  online: { label: "Connected", tone: "done" },
  connecting: { label: "Connecting", tone: "waiting" },
  offline: { label: "Offline", tone: "idle" },
  auth_failed: { label: "Pair again", tone: "failed" },
};
export function machineProblem(status: MachineStatus, failed: boolean) {
  if (status === "auth_failed")
    return "Access was refused. Forget this machine and add it with a fresh pairing link.";
  if (failed && status === "offline")
    return "Couldn't reach this machine. Check that it is on and connected, then reconnect.";
  return "Paired machine";
}
