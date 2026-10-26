import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
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
  type LinkGap,
} from "./fleet-links.ts";
import type { PairedDevice } from "./fleet.ts";

/**
 * Everything the Fleet pages read, from every machine at once: their links, devices and open
 * pairing links, what's missing between them, and the actions that change it.
 */
export function useFleet() {
  const machines = useMachines();
  const links = useFleetLinks(machines);
  const devices = useFleetDevices(machines);
  const pairings = useFleetPairings(machines);
  const queries = useQueryClient();

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

  const byId = (id: string) => machines.find((machine) => machine.id === id);
  const refresh = (ids: readonly string[]) =>
    Promise.all(
      ids.flatMap((id) => [
        queries.invalidateQueries({ queryKey: fleetKeys.links(id) }),
        queries.invalidateQueries({ queryKey: fleetKeys.devices(id) }),
      ]),
    );

  /** Link every direction in `wanted`, one after another so each machine pairs once at a time. */
  const link = useMutation({
    mutationFn: async (wanted: readonly LinkGap[]) => {
      const failures: string[] = [];
      for (const gap of wanted) {
        const from = byId(gap.from);
        const to = byId(gap.to);
        if (!from || !to) continue;
        try {
          await linkMachine(from, to, "operate");
        } catch (error) {
          failures.push(
            error instanceof Error ? error.message : `${from.name} didn't link to ${to.name}.`,
          );
        }
      }
      await refresh(wanted.flatMap((gap) => [gap.from, gap.to]));
      if (failures.length) throw new Error(failures.join("\n"));
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
    gaps,
    joined,
    link,
    unlink,
    refresh,
    byId,
  };
}

export type Fleet = ReturnType<typeof useFleet>;
