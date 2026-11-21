import { useMemo, type ReactNode } from "react";
import { useDaemonConnection } from "@/boot/connection.tsx";
import { useMachines, type Machine } from "@/lib/machines.ts";
import { SpaceScopeProvider, type SpaceScope } from "@/lib/space-scope.ts";
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

/**
 * Gives the foundations the space's machines (`useSpaceScope`), so projects and threads follow
 * the space by the machine they live on (ADR 0206 §2.4), from this one mapping.
 */
export function SpaceScopeHost(props: { children: ReactNode }) {
  const machines = useSpaceMachines();
  const space = useSpace().shown?.id;
  const ids = machines.map((machine) => machine.id).join("\n");
  const scope = useMemo<SpaceScope>(
    () => ({ space, machines: new Set(ids ? ids.split("\n") : []) }),
    [space, ids],
  );
  return <SpaceScopeProvider value={scope}>{props.children}</SpaceScopeProvider>;
}
