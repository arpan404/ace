import type { MachineEntry } from "@ace/client/machines";
import type { StartupRoute } from "../runtime/production-startup.ts";

/**
 * Pure production UI wiring: which machine is active, what each row may do,
 * and what the route means on screen.
 *
 * No networking, no storage and no secrets. Screens resolve these before
 * admitting inbox, approval, question, composer or file actions; the daemon
 * re-enforces the grant. Unknown hosts and known hosts with no recorded
 * grant row stay view-only (fail closed).
 */

export interface MachineCard {
  readonly hostId: string;
  readonly displayName: string;
  /** Whether this phone may send commands to this machine. */
  readonly canOperate: boolean;
  readonly route: StartupRoute;
}

export function machineCards(input: {
  entries: readonly MachineEntry[];
  canOperate(hostId: string): boolean;
  route(hostId: string): StartupRoute;
}): MachineCard[] {
  return input.entries.map((entry) => ({
    hostId: entry.hostId,
    displayName: entry.displayName,
    canOperate: input.canOperate(entry.hostId),
    route: input.route(entry.hostId),
  }));
}

/** Active machine for the inbox placeholder: the preferred host when still paired, else the first. */
export function selectActiveHost(
  entries: readonly MachineEntry[],
  preferred?: string | undefined,
): string | undefined {
  if (preferred !== undefined && entries.some((entry) => entry.hostId === preferred)) {
    return preferred;
  }
  return entries[0]?.hostId;
}

/** Screen text for a machine that cannot show its inbox yet. Null while paired. */
export function routeMessage(route: StartupRoute): string | null {
  if (route.route === "paired") return null;
  return route.message;
}

/** Whether the production inbox placeholder may offer machine actions. */
export function canActMachines(canAct: boolean | undefined): boolean {
  return canAct === true;
}
