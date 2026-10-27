import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MachineCapability, MachineGrantLevel } from "@ace/protocol";
import { SettingNote, SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import type { Machine } from "@/lib/machines.ts";
import { fleetProblem } from "./data/fleet.ts";
import {
  capabilityRows,
  grantLevels,
  grantsKey,
  machineGrants,
  setGrant,
  type MachineGrantsAnswer,
} from "./data/fleet-grants.ts";
import { linkersOf, type Linker } from "./data/fleet-links.ts";
import type { Fleet } from "./data/use-fleet.ts";

/**
 * What each linked machine's agents may do on this one (ADR 0105): one section per machine that
 * reaches it, with Agents, Browser, Simulators & emulators, Computer use and Commands each Off,
 * Read only or Read and act. A change applies to that machine's next call.
 */
export function LinkedMachineAccess(props: { machine: Machine; fleet: Fleet }) {
  const { machine, fleet } = props;
  const client = machine.client;
  const linkers = linkersOf(machine.id, fleet.facts);
  const ids = linkers.map((linker) => linker.deviceId);
  const queries = useQueryClient();
  const toast = useToast();
  const key = grantsKey(machine.id);
  const query = useQuery({
    queryKey: [...key, ids.join(",")],
    queryFn: () => (client ? machineGrants(client, ids) : Promise.reject(new Error("Offline"))),
    enabled: client !== undefined && ids.length > 0,
  });
  const change = useMutation({
    mutationFn: async (input: {
      deviceId: string;
      capability: MachineCapability;
      level: MachineGrantLevel;
    }) => {
      if (!client) throw new Error(`${machine.name} is offline.`);
      await setGrant(client, input.deviceId, input.capability, input.level);
    },
    onSettled: () => queries.invalidateQueries({ queryKey: key }),
    onError: (error) => toast.error({ title: "Couldn't change it", description: error.message }),
  });
  if (linkers.length === 0) return null;
  if (!client)
    return (
      <SettingSection label="Linked machines' agents here" anchor="linked-access">
        <SettingNote>What they may do here shows when {machine.name} is back online.</SettingNote>
      </SettingSection>
    );
  const closed = query.data?.master === "off";
  return (
    <>
      {query.isError && (
        <SettingSection label="Linked machines' agents here" anchor="linked-access">
          <SettingNote role="alert">{fleetProblem(query.error)}</SettingNote>
        </SettingSection>
      )}
      {linkers.map((linker) => (
        <LinkerSection
          key={linker.id}
          linker={linker}
          host={machine.name}
          answer={query.data}
          closed={closed}
          pending={change.isPending}
          onChange={(capability, level) =>
            change.mutate({ deviceId: linker.deviceId, capability, level })
          }
        />
      ))}
    </>
  );
}

function LinkerSection(props: {
  linker: Linker;
  host: string;
  answer: MachineGrantsAnswer | undefined;
  closed: boolean;
  pending: boolean;
  onChange(capability: MachineCapability, level: MachineGrantLevel): void;
}) {
  const { linker, answer } = props;
  const entry = answer?.devices.find((device) => device.deviceId === linker.deviceId);
  const note = props.closed
    ? `Agents from other machines are off on ${props.host}, so ${linker.name}'s agents can't use it. Turn them on above.`
    : answer && !entry
      ? `${linker.name} isn't paired with ${props.host} any more. Link them again.`
      : undefined;
  return (
    <SettingSection
      label={`${linker.name}'s agents on ${props.host}`}
      anchor={`linked-access-${linker.id}`}
      note={note}
    >
      {capabilityRows.map((row) => (
        <SettingRow key={row.capability} title={row.title} description={row.note}>
          <SegmentedControl
            label={`${row.title} for ${linker.name}`}
            value={entry?.grants[row.capability] ?? "off"}
            options={grantLevels}
            disabled={!entry || props.closed || props.pending}
            onValueChange={(level) => props.onChange(row.capability, level)}
          />
        </SettingRow>
      ))}
    </SettingSection>
  );
}
