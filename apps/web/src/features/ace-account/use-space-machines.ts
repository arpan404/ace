import { useMemo } from "react";
import { useDaemonConnection } from "@/boot/connection.tsx";
import { useMachines, type Machine } from "@/lib/machines.ts";
import { useSpace } from "./space-context.tsx";
import { machinesInSpace } from "./spaces.ts";

/**
 * The window's machines that belong to its space (ADR 0206 §1.5): an organization's hosts in its
 * space, the rest in Personal. For what lists a space's own data, such as Spade's bots; the
 * window's connections are never closed by switching.
 */
export function useSpaceMachines(): Machine[] {
  const machines = useMachines();
  const own = useDaemonConnection().account?.hostId;
  const { shown, hostsOf, spaces } = useSpace();
  return useMemo(
    () =>
      machinesInSpace(
        machines,
        (machine) => (machine.primary ? own : machine.id),
        shown,
        hostsOf,
        (spaces ?? []).map((space) => space.id),
      ),
    [machines, own, shown, hostsOf, spaces],
  );
}
