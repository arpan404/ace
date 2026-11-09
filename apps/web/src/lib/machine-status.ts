import type { MachineStatus } from "./machines.ts";
import type { Tone } from "@ace/ui-core";

export const machineStatus: Record<MachineStatus, { label: string; tone: Tone }> = {
  online: { label: "Connected", tone: "done" },
  connecting: { label: "Connecting", tone: "waiting" },
  offline: { label: "Offline", tone: "idle" },
  auth_failed: { label: "Pair again", tone: "failed" },
  machine_code: { label: "Needs its machine code", tone: "waiting" },
  off: { label: "Off on this device", tone: "idle" },
};
export function machineProblem(status: MachineStatus, failed: boolean) {
  if (status === "auth_failed")
    return "Access was refused. Forget this machine and add it with a fresh pairing link.";
  if (failed && status === "offline")
    return "Couldn't reach this machine. Check that it is on and connected, then reconnect.";
  if (status === "off")
    return "Turned off on this device. Its threads are hidden until you turn it on.";
  return "Paired machine";
}
