import type { FleetLink } from "@ace/protocol";
import { columns } from "./provider-columns.ts";

const statusWords: Readonly<Record<FleetLink["status"], string>> = {
  online: "online",
  offline: "offline",
  refused: "doesn't let agents in",
};

/** `ace machine list`: each linked machine by the name agents use, and whether it answers. Pure. */
export function machineListLines(value: { machines: readonly FleetLink[] }): string[] {
  if (!value.machines.length)
    return ["No other machines linked. Link one in the app's Fleet page, or ace device pair."];
  return columns(
    value.machines.map((machine) => [
      machine.profile,
      machine.name === machine.profile ? undefined : machine.name,
      statusWords[machine.status],
      machine.access,
    ]),
  );
}

export function machineNames(value: { machines: readonly FleetLink[] }): string[] {
  return value.machines.map((machine) => machine.profile);
}
