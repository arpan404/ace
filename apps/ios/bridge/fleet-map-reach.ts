import {
  accountReachLine,
  directLine,
  networkOffQuestion,
  clientDependents,
  remoteOffLine,
  type FleetDevice,
  type FleetMachineFacts,
  type NetworkOffQuestion,
  type Tone,
} from "@ace/ui-core/fleet-map";
import type { FleetMapPart } from "./fleet-map-part.ts";

/*
 * How one machine is reached, as the web's reach rows say it for a machine other than this
 * computer: its ace account, Tailscale and the local network, each a dot, one sentence and one
 * action, or remote access off with the action to turn it on. Turning a network off always asks
 * first: this phone reaches the machine, and when what else does couldn't be read, the question
 * says so. Pure.
 */

export interface ReachAction {
  label: string;
  /** The setting it writes on the machine, and the value. */
  key: string;
  value: boolean;
  /** Asked first; null when nothing depends on it. */
  confirm: NetworkOffQuestion | null;
}

export interface ReachRow {
  id: "remote" | "account" | "tailscale" | "lan";
  title: string;
  tone: Tone;
  /** The status token its dot is drawn in. */
  token: string;
  words: string;
  action: ReachAction | null;
}

export interface FleetMachineReach {
  id: string;
  name: string;
  rows: ReachRow[];
}

const tokens: Record<Tone, string> = { on: "done", warn: "needs-you", off: "idle" };

const direct = [
  { id: "tailscale", title: "Tailscale", key: "remote.tailscale" },
  { id: "lan", title: "Local network", key: "remote.lan" },
] as const;

export interface MachineReachInput {
  id: string;
  name: string;
  part: FleetMapPart;
  devices: readonly FleetDevice[];
  machines: readonly FleetMachineFacts[];
  /** The machines whose paired devices were read. */
  devicesRead: ReadonlySet<string>;
  /** This phone, which reaches every machine it shows and so always depends on it. */
  viewer: string;
}

export function machineReach(input: MachineReachInput): FleetMachineReach {
  const { id, name, part } = input;
  if (part.remote.enabled === false)
    return {
      id,
      name,
      rows: [
        {
          id: "remote",
          title: "Remote access",
          ...remoteOffLine(name),
          token: tokens.off,
          action: { label: "Turn on", key: "remote.enabled", value: true, confirm: null },
        },
      ],
    };
  const dependents = clientDependents({
    machine: id,
    devices: input.devices,
    machines: input.machines,
    devicesRead: input.devicesRead,
    viewer: input.viewer,
  });
  const account = accountReachLine(part.networks?.account, name);
  return {
    id,
    name,
    rows: [
      {
        id: "account",
        title: "ace account",
        ...account,
        token: tokens[account.tone],
        action: null,
      },
      ...direct.map((row): ReachRow => {
        const on = part.remote[row.id];
        const line = directLine(row.id, on === true, part.networks?.[row.id]);
        return {
          id: row.id,
          title: row.title,
          tone: line.tone,
          token: tokens[line.tone],
          words: line.words,
          // A setting that couldn't be read offers nothing to change.
          action:
            on === null
              ? null
              : on
                ? {
                    label: "Turn off",
                    key: row.key,
                    value: false,
                    confirm:
                      networkOffQuestion({ network: row.title, where: name, dependents }) ?? null,
                  }
                : { label: "Turn on", key: row.key, value: true, confirm: null },
        };
      }),
    ],
  };
}
