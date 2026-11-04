import type { SidebarReader } from "@ace/client";
import { useSelection, useSidebarAll } from "@ace/client-react";
import type { ThreadListEntry } from "@ace/protocol";
import { useMemo } from "react";
import { hostedRelayUrl } from "@/boot/account-config.ts";
import { useAccountMachines } from "@/features/ace-account/index.ts";
import { useMachinePool } from "@/lib/machine-pool.ts";
import { useNow } from "@/lib/time.ts";
import { reach } from "./fleet-links.ts";
import { fleetMapFacts } from "./fleet-map-facts.ts";
import { hostOf } from "./fleet-map-networks.ts";
import type { AccountOpening, FleetMap, FleetMapInput } from "./fleet-map-types.ts";
import { settingKeys } from "./setting-keys.ts";
import { useFleet, type Fleet } from "./use-fleet.ts";
import { useRemoteStatus, useSettingControl } from "./use-settings.ts";

/*
 * The Fleet map's facts from the hooks the Fleet pages already read: every machine and its
 * links, the account's machines, the paired devices, this computer's networks, and how many
 * agents work on each machine from its thread list.
 */

const working = (entry: ThreadListEntry | undefined) =>
  entry?.status.state === "working" ? entry.status.agents : 0;

/** Agents working in this window's own list; undefined until the daemon's list is in. */
const ownWorking = (reader: SidebarReader) =>
  reader.loaded && !reader.unconfirmed && !reader.syncing
    ? reader.ids.reduce((sum, id) => sum + working(reader.thread(id)), 0)
    : undefined;

const sameCounts = (a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>) =>
  a.size === b.size && [...a].every(([key, value]) => b.get(key) === value);
const noCounts: ReadonlyMap<string, number> = new Map();

/** Agents working on each other machine, from the pool's merged thread lists. */
function usePoolWorking(): ReadonlyMap<string, number> {
  const pool = useMachinePool();
  const selection = useMemo(
    () =>
      pool?.threads.select(
        ["ids", "threads"],
        (store) => {
          const counts = new Map<string, number>();
          for (const key of store.ids) {
            const row = store.thread(key);
            if (row) counts.set(row.hostId, (counts.get(row.hostId) ?? 0) + working(row.thread));
          }
          return counts;
        },
        sameCounts,
      ),
    [pool],
  );
  return useSelection(selection) ?? noCounts;
}

export interface FleetMapData {
  fleet: Fleet;
  account: ReturnType<typeof useAccountMachines>;
  map: FleetMap;
  ownId: string;
}

/** Everything the map draws, with the fleet and account it came from for the panel's actions. */
export function useFleetMap(openings: ReadonlyMap<string, AccountOpening>): FleetMapData {
  const fleet = useFleet();
  const account = useAccountMachines(fleet.machines);
  const enabled = useSettingControl(settingKeys.remoteEnabled, "Remote access");
  const networks = useRemoteStatus().data?.networks;
  const now = useNow();
  const own = fleet.machines.find((machine) => machine.primary) ?? fleet.machines[0];
  const ownCount = useSidebarAll(ownWorking);
  const poolCounts = usePoolWorking();
  const ownId = own?.id ?? "primary";
  const input: FleetMapInput = {
    own: {
      id: ownId,
      name: own?.name ?? "This computer",
      icon: own?.icon?.kind,
      online: own?.status === "online",
      working: ownCount,
    },
    enabled: enabled.loaded ? enabled.value : undefined,
    networks: enabled.loaded ? networks : undefined,
    relayHost: hostOf(hostedRelayUrl()),
    machines: fleet.machines
      .filter((machine) => !machine.primary)
      .map((machine) => ({
        id: machine.id,
        name: machine.name,
        icon: machine.icon?.kind,
        status: machine.status,
        failed: !!machine.failed,
        via: machine.via,
        // A machine's last list says nothing about now while it's offline.
        working: machine.status === "online" ? (poolCounts.get(machine.id) ?? 0) : undefined,
      })),
    account: account.only.map((machine) => ({
      ...machine,
      opening: openings.get(machine.hostId),
    })),
    devices: fleet.joined.map((device) => ({
      key: device.key,
      name: device.name,
      on: device.on.map((entry) => entry.machine),
      lastSeenAt: device.lastSeenAt,
      expiresAt: device.expiresAt,
      self: device.self,
      readOnly: device.on.every((entry) => !entry.device.scopes.includes("operate")),
    })),
    links: fleet.facts.flatMap((from) =>
      fleet.facts
        .filter((to) => to.id !== from.id && reach(from, to).kind === "linked")
        .map((to) => ({ from: from.id, to: to.id })),
    ),
    now,
  };
  return { fleet, account, map: fleetMapFacts(input), ownId };
}
