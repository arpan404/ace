import type { ReactNode } from "react";
import { Screen } from "@/features/shell/index.ts";
import { MachineScope } from "@/lib/machine-scope.tsx";
import { useMachinePool } from "@/lib/machine-pool.ts";
import { useMachines, type Machine } from "@/lib/machines.ts";

/** Why work on a machine can't show right now, in one line. */
export function machineAwayText(machine: Machine): string {
  if (machine.status === "auth_failed")
    return `${machine.name} refused this device. Pair it again in Settings › Fleet.`;
  if (machine.status === "connecting") return `Connecting to ${machine.name}…`;
  return `${machine.name} isn't connected. Its work shows here when it's back.`;
}

/**
 * Renders a route's view on the machine its `?machine=` names (ADR 0102): under that machine's
 * client, or this window's own when it names none or names this one. A machine that is offline
 * or not in this window's pool says so; nothing falls back to another machine.
 */
export function OnMachine(props: {
  machine: string | undefined;
  title: string;
  children: ReactNode;
}) {
  const machines = useMachines();
  const pool = useMachinePool();
  const own = machines[0];
  if (!props.machine || !own || own.id === props.machine) return props.children;
  const machine = machines.find((each) => each.id === props.machine);
  const away = (text: string) => (
    <Screen title={props.title}>
      <p role="status" className="px-5 py-6 text-ui text-muted-foreground">
        {text}
      </p>
    </Screen>
  );
  if (!machine)
    return away(
      pool
        ? "This window isn't paired with that machine. Add it in Settings › Fleet."
        : "Connecting to your other machines…",
    );
  return (
    <MachineScope key={machine.id} machine={machine} unavailable={away(machineAwayText(machine))}>
      {props.children}
    </MachineScope>
  );
}
