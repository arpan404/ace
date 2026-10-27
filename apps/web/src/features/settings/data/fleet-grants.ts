import type { ClientApi } from "@ace/client";
import {
  DeviceId,
  type FleetOutcome,
  type MachineCapability,
  type MachineGrantLevel,
} from "@ace/protocol";
import { fleet } from "./fleet.ts";

/*
 * What each linked machine's agents may do on a machine, per capability (ADR 0105). Read and set
 * through that machine's own client, like its links and devices.
 */

export type MachineGrantsAnswer = Extract<FleetOutcome, { kind: "grants" }>;

export const grantLevels = [
  { value: "off", label: "Off" },
  { value: "read", label: "Read only" },
  { value: "operate", label: "Read and act" },
] as const satisfies readonly { value: MachineGrantLevel; label: string }[];

/** The five capabilities, in the order Settings shows them, with what each lets agents do. */
export const capabilityRows: readonly {
  capability: MachineCapability;
  title: string;
  note: string;
}[] = [
  { capability: "agents", title: "Agents", note: "Start threads here, message and stop them." },
  { capability: "browser", title: "Browser", note: "Read and use this machine's browser." },
  {
    capability: "devices",
    title: "Simulators & emulators",
    note: "List, start, drive and screenshot them.",
  },
  { capability: "screen", title: "Computer use", note: "See and use this machine's apps." },
  {
    capability: "commands",
    title: "Commands",
    note: "Run commands in this machine's projects without asking each time. Every one is logged.",
  },
];

export const grantsKey = (machine: string) => ["fleet", "grants", machine] as const;

export async function machineGrants(
  client: ClientApi,
  deviceIds: readonly string[],
): Promise<MachineGrantsAnswer> {
  const result = await fleet(client, {
    op: "grants",
    deviceIds: deviceIds.map((id) => DeviceId.parse(id)),
  });
  if (result.kind !== "grants") throw new Error("That machine didn't answer with its grants.");
  return result;
}

export async function setGrant(
  client: ClientApi,
  deviceId: string,
  capability: MachineCapability,
  level: MachineGrantLevel,
): Promise<void> {
  const result = await fleet(client, {
    op: "grant",
    deviceId: DeviceId.parse(deviceId),
    capability,
    level,
  });
  if (result.kind !== "grants") throw new Error("That machine didn't keep the change.");
}
