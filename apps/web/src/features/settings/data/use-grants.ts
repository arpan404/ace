import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import type { MachineCapability, MachineGrantLevel } from "@ace/protocol";
import type { Machine } from "@/lib/machines.ts";
import { capabilityRows, grantsKey, machineGrants, setGrant } from "./fleet-grants.ts";
import { linkersOf } from "@ace/ui-core/fleet-map";
import type { Fleet } from "./use-fleet.ts";

/** A capability's level across the links being edited; "mixed" while they disagree. */
export type GrantValue = MachineGrantLevel | "mixed";

/**
 * What linked machines' agents may use, read and set across a set of links: on each machine in
 * `hosts`, the links held to it by `peer` (a machine's id, or "all" for every linker). Each
 * grant lives on the machine being used, so each host is read and written through its own
 * client (ADR 0105).
 */
export function useGrants(fleet: Fleet, hosts: readonly Machine[], peer: string) {
  const groups = hosts.map((machine) => ({
    machine,
    targets: linkersOf(machine.id, fleet.facts).filter(
      (linker) => peer === "all" || linker.id === peer,
    ),
  }));
  const targets = groups.flatMap((group) =>
    group.targets.map((target) => ({ ...target, machine: group.machine })),
  );
  const queries = useQueryClient();
  const results = useQueries({
    queries: groups.map(({ machine, targets: incoming }) => ({
      queryKey: [...grantsKey(machine.id), incoming.map((target) => target.deviceId).join(",")],
      queryFn: () =>
        machine.client
          ? machineGrants(
              machine.client,
              incoming.map((target) => target.deviceId),
            )
          : Promise.reject(new Error("Offline")),
      enabled: machine.client !== undefined && incoming.length > 0,
    })),
  });
  const change = useMutation({
    mutationFn: async (input: { capability: MachineCapability; level: MachineGrantLevel }) => {
      const failed: string[] = [];
      for (const target of targets) {
        try {
          if (!target.machine.client) throw new Error("Offline");
          await setGrant(target.machine.client, target.deviceId, input.capability, input.level);
        } catch {
          failed.push(`${target.name} on ${target.machine.name}`);
        }
      }
      if (failed.length)
        throw new Error(
          `Couldn't save it for ${failed.length} of ${targets.length} links: ${failed.slice(0, 3).join(", ")}. The others kept it. Try again to apply it there.`,
        );
    },
    onSettled: () =>
      Promise.all(
        hosts.map((machine) => queries.invalidateQueries({ queryKey: grantsKey(machine.id) })),
      ),
  });
  const answers = new Map(groups.map((group, index) => [group.machine.id, results[index]?.data]));
  const loaded =
    targets.length > 0 &&
    targets.every((target) =>
      answers.get(target.machine.id)?.devices.some((entry) => entry.deviceId === target.deviceId),
    );
  const valueOf = (capability: MachineCapability): GrantValue | undefined => {
    if (!loaded) return undefined;
    const values = targets.map(
      (target) =>
        answers.get(target.machine.id)?.devices.find((entry) => entry.deviceId === target.deviceId)
          ?.grants[capability],
    );
    const first = values[0];
    return first && values.every((level) => level === first) ? first : "mixed";
  };
  const values = Object.fromEntries(
    capabilityRows.map((row) => [row.capability, valueOf(row.capability)]),
  ) as Record<MachineCapability, GrantValue | undefined>;
  const failures = groups.flatMap((group, index) => {
    const result = results[index];
    return result?.isError ? [{ machine: group.machine, error: result.error }] : [];
  });
  return {
    targets,
    loaded,
    values,
    /** Every capability's single level, or undefined while any differs or hasn't loaded. */
    levels: Object.values(values).every((value) => value && value !== "mixed")
      ? (values as Record<MachineCapability, MachineGrantLevel>)
      : undefined,
    loading: groups.some((group, index) => group.targets.length > 0 && results[index]?.isPending),
    fetching: results.some((result) => result.isFetching),
    /** A host lets no agents in, or only reads: these grants can't go past that there. */
    closed: results.some((result) => result.data?.master === "off"),
    limited: results.some((result) => result.data?.master === "read"),
    failures,
    change,
  };
}

export type Grants = ReturnType<typeof useGrants>;
