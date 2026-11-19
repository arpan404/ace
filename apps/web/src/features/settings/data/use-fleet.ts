import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { useMachines, type Machine } from "@/lib/machines.ts";
import {
  fleetKeys,
  linkMachine,
  unlinkMachine,
  useFleetDevices,
  useFleetLinks,
  useFleetPairings,
} from "./fleet.ts";
import {
  fleetDevices,
  linkDeviceIds,
  linkGaps,
  type FleetMachineFacts,
  type FleetReads,
  type LinkGap,
} from "@ace/ui-core/fleet-map";
import type { PairedDevice } from "./fleet.ts";
import { useFleetUpdate } from "./use-fleet-update.ts";

/** Read only when the latest fetch returned: data kept from before a failed refetch is stale. */
const latest = (query: { data?: unknown; isError: boolean } | undefined) =>
  query?.data !== undefined && !query.isError;

/**
 * Everything the Fleet pages read, from every machine at once: their links, devices, open
 * pairing links and updates, what's missing between them, and the actions that change it.
 */
export function useFleet() {
  const machines = useMachines();
  const links = useFleetLinks(machines);
  const devices = useFleetDevices(machines);
  const pairings = useFleetPairings(machines);
  const update = useFleetUpdate(machines, devices);
  const queries = useQueryClient();
  const toast = useToast();

  const facts: FleetMachineFacts[] = machines.map((machine) => ({
    id: machine.id,
    name: machine.name,
    online: machine.client !== undefined,
    links: links.get(machine.id)?.data,
  }));
  const factsKey = JSON.stringify(facts);
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- keyed by the facts' content
  const gaps = useMemo(() => linkGaps(facts), [factsKey]);
  const linkIds = linkDeviceIds(facts);
  const deviceLists = new Map<string, readonly PairedDevice[]>();
  for (const machine of machines) {
    const list = devices.get(machine.id)?.data;
    if (list) deviceLists.set(machine.id, list);
  }
  const joined = fleetDevices(deviceLists, linkIds);
  /** The machines whose devices and links the latest read returned; the rest are unknown. */
  const reads: FleetReads = {
    devices: new Set(
      machines.filter((machine) => latest(devices.get(machine.id))).map((machine) => machine.id),
    ),
    links: new Set(
      machines.filter((machine) => latest(links.get(machine.id))).map((machine) => machine.id),
    ),
  };

  const byId = (id: string) => machines.find((machine) => machine.id === id);
  const refresh = (ids: readonly string[]) =>
    Promise.all(
      ids.flatMap((id) => [
        queries.invalidateQueries({ queryKey: fleetKeys.links(id) }),
        queries.invalidateQueries({ queryKey: fleetKeys.devices(id) }),
      ]),
    );

  /**
   * Link every direction in `wanted`, one after another so each machine pairs once at a time. A
   * direction linked meanwhile keeps its link. Answers how many directions it linked.
   */
  const link = useMutation({
    mutationFn: async (wanted: readonly LinkGap[]): Promise<{ linked: number }> => {
      const failures: string[] = [];
      const withoutProjects: Machine[] = [];
      const outdated: Machine[] = [];
      let linked = 0;
      for (const gap of wanted) {
        const from = byId(gap.from);
        const to = byId(gap.to);
        if (!from || !to) continue;
        try {
          const made = await linkMachine(from, to, "operate");
          if (made.kind === "kept") continue;
          if (made.kind === "outdated") {
            if (!outdated.includes(from)) outdated.push(from);
            continue;
          }
          linked++;
          if (!made.projects && !withoutProjects.includes(to)) withoutProjects.push(to);
        } catch (error) {
          failures.push(
            error instanceof Error ? error.message : `${from.name} didn't link to ${to.name}.`,
          );
        }
      }
      await refresh(wanted.flatMap((gap) => [gap.from, gap.to]));
      // Linked, but this window couldn't hand out Projects there: say how to allow them later.
      for (const to of withoutProjects)
        toast.add({
          title: `Linked without Projects on ${to.name}`,
          description: `This device can't grant Projects on ${to.name}, so work can't move there yet. Allow projects on ${to.name}'s page in Settings › Fleet.`,
        });
      // An ace from before Link all could keep a link it holds: never asked, so never replaced.
      for (const from of outdated)
        toast.add({
          title: `Update ace on ${from.name}`,
          description: `${from.name} needs ace updated before Link all can link it to other machines.`,
        });
      if (failures.length) throw new Error(failures.join("\n"));
      return { linked };
    },
  });

  /**
   * Unlink both directions between `machine` and each of `others`. Every direction is tried; a
   * machine that's offline keeps its side until it's back, and the failures are reported together.
   */
  const unlink = useMutation({
    mutationFn: async (input: { machine: Machine; others: readonly Machine[] }) => {
      const failures: string[] = [];
      for (const other of input.others)
        for (const [from, to] of [
          [input.machine, other],
          [other, input.machine],
        ] as const) {
          const held = links.get(from.id)?.data?.find((entry) => entry.hostId === to.id);
          if (!held) continue;
          try {
            await unlinkMachine(from, to, held);
          } catch (error) {
            failures.push(error instanceof Error ? error.message : `${from.name} didn't unlink.`);
          }
        }
      await refresh([input.machine.id, ...input.others.map((other) => other.id)]);
      if (failures.length) throw new Error(failures.join("\n"));
    },
  });

  return {
    machines,
    facts,
    links,
    devices,
    pairings,
    update,
    gaps,
    joined,
    reads,
    link,
    unlink,
    refresh,
    byId,
  };
}

export type Fleet = ReturnType<typeof useFleet>;
