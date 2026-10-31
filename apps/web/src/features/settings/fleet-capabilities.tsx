import { useState } from "react";
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import type { MachineCapability, MachineGrantLevel } from "@ace/protocol";
import { SettingNote, SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Select } from "@/components/ui/select.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import type { Machine } from "@/lib/machines.ts";
import { fleetProblem } from "./data/fleet.ts";
import {
  capabilityRows,
  grantLevels,
  grantsKey,
  machineGrants,
  setGrant,
} from "./data/fleet-grants.ts";
import { linkersOf } from "./data/fleet-links.ts";
import type { Fleet } from "./data/use-fleet.ts";

/** Shared settings apply incoming-link grants across all connected hosts. */
export function FleetMachineAccess(props: { fleet: Fleet }) {
  const [peer, setPeer] = useState("all");
  return (
    <MachineAccessEditor
      machines={props.fleet.machines.filter((machine) => machine.client)}
      fleet={props.fleet}
      peer={peer}
      onPeerChange={setPeer}
      hostLabel="the connected fleet machines"
    />
  );
}

/** One permission editor for a selected source machine or all current incoming links. */
export function LinkedMachineAccess(props: { machine: Machine; fleet: Fleet; peer: string }) {
  return (
    <MachineAccessEditor
      machines={[props.machine]}
      fleet={props.fleet}
      peer={props.peer}
      hostLabel={props.machine.name}
    />
  );
}

function MachineAccessEditor(props: {
  machines: readonly Machine[];
  fleet: Fleet;
  peer: string;
  onPeerChange?(peer: string): void;
  hostLabel: string;
}) {
  const { fleet } = props;
  const groups = props.machines.map((machine) => ({
    machine,
    targets: linkersOf(machine.id, fleet.facts).filter(
      (linker) => props.peer === "all" || linker.id === props.peer,
    ),
  }));
  const targets = groups.flatMap((group) =>
    group.targets.map((target) => ({ ...target, machine: group.machine })),
  );
  const queries = useQueryClient();
  const toast = useToast();
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
          `Couldn't save permissions for ${failed.length} of ${targets.length} links: ${failed.slice(0, 3).join(", ")}. Saved changes on the other machines are kept. Retry to apply this level again.`,
        );
    },
    onSettled: () =>
      Promise.all(
        props.machines.map((machine) =>
          queries.invalidateQueries({ queryKey: grantsKey(machine.id) }),
        ),
      ),
    onError: (error) =>
      toast.error({ title: "Some permissions weren't saved", description: error.message }),
  });
  const answers = new Map(groups.map((group, index) => [group.machine.id, results[index]?.data]));
  const closed = results.some((result) => result.data?.master === "off");
  const limited = results.some((result) => result.data?.master === "read");
  const label =
    props.peer === "all"
      ? "All linked machines"
      : (fleet.byId(props.peer)?.name ?? "Selected machine");
  const loaded =
    targets.length > 0 &&
    targets.every((target) =>
      answers.get(target.machine.id)?.devices.some((entry) => entry.deviceId === target.deviceId),
    );
  const sourceCount = new Set(targets.map((target) => target.id)).size;
  return (
    <SettingSection
      label="Linked machine permissions"
      anchor="linked-access"
      note={`What the selected machines' agents may do on ${props.hostLabel}.`}
    >
      {props.onPeerChange && (
        <SettingRow
          title="Apply to"
          description={
            props.peer === "all"
              ? `Changes apply to all ${sourceCount} currently linked machines. New links use their defaults.`
              : `Changes apply only to ${label}.`
          }
        >
          <Select
            label="Machines to configure"
            value={props.peer}
            options={[
              { value: "all", label: "All linked machines" },
              ...fleet.machines
                .filter((entry) => props.machines.length > 1 || entry.id !== props.machines[0]?.id)
                .map((entry) => ({ value: entry.id, label: entry.name })),
            ]}
            disabled={change.isPending}
            onValueChange={(value) => props.onPeerChange?.(value)}
          />
        </SettingRow>
      )}
      {!props.onPeerChange && (
        <SettingNote>
          Editing permissions for {label} on {props.hostLabel}. New links use their defaults.
        </SettingNote>
      )}
      {props.machines.some((machine) => !machine.client) && (
        <SettingNote>Connect to {props.hostLabel} to change permissions.</SettingNote>
      )}
      {targets.length === 0 && (
        <SettingNote>Link the machines first to configure their permissions.</SettingNote>
      )}
      {closed && (
        <SettingNote>
          Agent access is off on one or more selected machines. Enable agent access above for these
          permissions to take effect there.
        </SettingNote>
      )}
      {limited && (
        <SettingNote>
          Some selected machines limit agent access to Read. These permissions cannot allow actions
          there until that limit changes.
        </SettingNote>
      )}
      {groups.map((group, index) => {
        const result = results[index];
        return result?.isError ? (
          <SettingNote key={group.machine.id} role="alert">
            {group.machine.name}: {fleetProblem(result.error)}
          </SettingNote>
        ) : null;
      })}
      {capabilityRows.map((row) => {
        const values = targets.map(
          (target) =>
            answers
              .get(target.machine.id)
              ?.devices.find((entry) => entry.deviceId === target.deviceId)?.grants[row.capability],
        );
        const first = values[0];
        const value = loaded && first && values.every((level) => level === first) ? first : "mixed";
        return (
          <SettingRow key={row.capability} title={row.title} description={row.note}>
            <Select<MachineGrantLevel | "mixed">
              label={`${row.title} for ${label}`}
              value={value}
              options={[
                {
                  value: "mixed",
                  label: loaded
                    ? "Mixed"
                    : targets.length === 0
                      ? "Not linked"
                      : groups.some(
                            (group, index) => group.targets.length > 0 && results[index]?.isPending,
                          )
                        ? "Loading…"
                        : "Unavailable",
                  disabled: true,
                },
                ...grantLevels,
              ]}
              disabled={!loaded || change.isPending || results.some((result) => result.isFetching)}
              onValueChange={(level) => {
                if (level !== "mixed") change.mutate({ capability: row.capability, level });
              }}
            />
          </SettingRow>
        );
      })}
    </SettingSection>
  );
}
