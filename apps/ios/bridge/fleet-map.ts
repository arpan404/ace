import { MachineIconKind, type Device } from "@ace/protocol";
import {
  capitalize,
  deviceNode,
  fixLabel,
  fleetDevices,
  linkDeviceIds,
  machineNode,
  nodeFixes,
  nodeStateWords,
  removeDeviceQuestion,
  signInHint,
  summaryLine,
  type FleetDevice,
  type FleetMachineFacts,
  type FleetMapInput,
  type FleetReads,
  type MachineStatus,
  type MachineVia,
  type MapArt,
  type MapFix,
  type MapMachineInput,
  type MapNode,
  type MapTone,
} from "@ace/ui-core/fleet-map";
import { z } from "zod";
import { FleetMapPart } from "./fleet-map-part.ts";
import { machineReach, type FleetMachineReach } from "./fleet-map-reach.ts";

/*
 * The phone's Fleet map, as the web's map falls back to a list when it's too narrow to draw:
 * every paired machine with how this phone reaches it, every device paired across them, each
 * with its state, its problem in words and the fix, plus how each machine is reached. The phone
 * has no computer of its own, so a device is judged against the machine it's paired with that
 * answers. Swift gathers each machine's part (`fleet-map-part.ts`) and its own facts about the
 * connection; the nodes and words are the web's, from `@ace/ui-core/fleet-map`. Pure.
 */

const Machine = z.object({
  id: z.string().min(1).max(256),
  name: z.string().min(1).max(128),
  icon: MachineIconKind.optional().catch(undefined),
  /** The runtime's connection state. */
  connection: z.enum(["connecting", "ready", "reconnecting", "offline"]).catch("connecting"),
  /** The runtime's reason code while it isn't ready. */
  problem: z.string().max(64).optional(),
  /** Turned off on this phone. */
  off: z.boolean().default(false),
  /** Its pairing here no longer works. */
  needsPairing: z.boolean().default(false),
  /** It waits for its machine code. */
  askingCode: z.boolean().default(false),
  /** The saved target: direct, relay, or an account machine through ace's relay. */
  target: z.object({ kind: z.string().max(32), url: z.string().max(2048) }).optional(),
  /** It's reached through ace's relay right now, as an account machine. */
  onAccountRelay: z.boolean().default(false),
  /** Agents it confirms are working now. */
  working: z.number().int().nonnegative().max(100_000).optional(),
  part: FleetMapPart.optional(),
});
type Machine = z.infer<typeof Machine>;

export const FleetMapCombineRequest = z.object({
  type: z.literal("fleetMap.combine"),
  machines: z.array(Machine).max(32),
});
export type FleetMapCombineRequest = z.infer<typeof FleetMapCombineRequest>;

/** This phone, starting a sentence and inside one. */
const viewer = "This iPhone";
const inSentence = "this iPhone";
const lostPairing = new Set(["pin", "revoked", "identity"]);

/** What the phone's connection to a machine says about it, as the web's pool does. */
export function machineStatusOf(machine: Machine): { status: MachineStatus; failed: boolean } {
  if (machine.needsPairing || lostPairing.has(machine.problem ?? ""))
    return { status: "auth_failed", failed: false };
  if (machine.off) return { status: "off", failed: false };
  if (machine.askingCode) return { status: "machine_code", failed: false };
  if (machine.connection === "ready") return { status: "online", failed: false };
  if (machine.connection === "connecting" && !machine.problem)
    return { status: "connecting", failed: false };
  return { status: "offline", failed: machine.problem === "unreachable" };
}

function viaOf(machine: Machine): MachineVia | undefined {
  const target = machine.target;
  if (!target) return undefined;
  if (machine.onAccountRelay || (target.kind !== "direct" && target.kind !== "relay"))
    return { kind: "account", url: target.url };
  return { kind: target.kind, url: target.url };
}

export type FleetFixAction =
  /** The machine's page has the flow: its code prompt, removing it. */
  | { kind: "open"; machine: string }
  | { kind: "retry"; machine: string }
  | { kind: "setting"; machine: string; key: string; value: boolean }
  | {
      kind: "revoke";
      devices: { machine: string; deviceId: string }[];
      confirm: { title: string; body: string; confirm: string };
    }
  | { kind: "hint"; text: string };

export interface FleetFix {
  id: MapFix;
  label: string;
  primary: boolean;
  action: FleetFixAction;
}

export interface FleetMapRow {
  id: string;
  kind: "machine" | "device";
  name: string;
  art: MapArt;
  tone: MapTone;
  /** The status token its dot is drawn in (`@ace/ui-core/mobile`). */
  token: string;
  /** Beside the dot: "Connected", "Needs you", "Can't connect", else its status. */
  state: string;
  /** Under the name: its status and how it's reached, "2 agents working · Tailscale". */
  line: string;
  lines: { label: string; value: string }[];
  problem: { what: string; why: string } | null;
  fixes: FleetFix[];
  /** A machine row's host id, to open its page; null for a device. */
  machine: string | null;
}

export interface FleetMapView {
  type: "fleetMap.view";
  /** "4 machines and devices. 1 connection needs you." */
  summary: string;
  problems: number;
  rows: FleetMapRow[];
  /** How each machine that answered is reached, for its reach section. */
  reach: FleetMachineReach[];
}

/**
 * "2 agents working · Tailscale": the status, then the wire's words when they add something. A
 * wire waiting on the person says only what its status already does.
 */
function lineOf(node: MapNode): string {
  const wire = node.wire;
  const adds =
    wire !== undefined &&
    wire.kind !== "needs" &&
    !node.status.toLowerCase().includes(wire.label.toLowerCase());
  return capitalize(adds ? `${node.status} · ${wire.label}` : node.status);
}

function actionOf(fix: MapFix, node: MapNode, home: string, device: FleetDevice | undefined) {
  switch (fix) {
    case "reconnect":
      return { kind: "retry", machine: node.id } as const;
    case "turnOnRemote":
    case "turnOnLan":
      return {
        kind: "setting",
        machine: home,
        key: fix === "turnOnLan" ? "remote.lan" : "remote.enabled",
        value: true,
      } as const;
    case "removeDevice":
      return device
        ? ({
            kind: "revoke",
            devices: device.on.map((entry) => ({
              machine: entry.machine,
              deviceId: entry.device.id,
            })),
            confirm: removeDeviceQuestion(device, viewer),
          } as const)
        : undefined;
    case "askSignIn":
      return { kind: "hint", text: signInHint(node.name) } as const;
    case "enterCode":
    case "removeMachine":
      return { kind: "open", machine: node.id } as const;
    // Account machines the phone hasn't opened are listed by the directory, not this map.
    case "openAccount":
    case "forgetMachine":
      return undefined;
  }
}

function rowOf(node: MapNode, home: string, device?: FleetDevice): FleetMapRow {
  const fixes = nodeFixes(node).flatMap((fix, index): FleetFix[] => {
    const action = actionOf(fix, node, home, device);
    return action ? [{ id: fix, label: fixLabel(node, fix), primary: index === 0, action }] : [];
  });
  return {
    id: node.id,
    kind: node.role === "device" ? "device" : "machine",
    name: node.name,
    art: node.art,
    tone: node.tone,
    token: toneTokens[node.tone],
    state: nodeStateWords(node),
    line: lineOf(node),
    lines: [...node.lines],
    problem: node.problem ? { what: node.problem.what, why: node.problem.why } : null,
    fixes,
    machine: node.role === "device" ? null : node.id,
  };
}

const toneTokens: Record<MapTone, string> = {
  on: "done",
  warn: "needs-you",
  bad: "failed",
  unknown: "idle",
};

const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name);

export function combineFleetMap(request: FleetMapCombineRequest, now: number): FleetMapView {
  const machines = request.machines.map((machine) => {
    const input: MapMachineInput = {
      id: machine.id,
      name: machine.name,
      icon: machine.icon,
      ...machineStatusOf(machine),
      via: viaOf(machine),
      working: machine.connection === "ready" ? (machine.working ?? 0) : undefined,
    };
    // A part read before the machine dropped says nothing about now.
    return { machine, input, part: input.status === "online" ? machine.part : undefined };
  });
  const facts: FleetMachineFacts[] = machines.map(({ machine, input, part }) => ({
    id: machine.id,
    name: machine.name,
    online: input.status === "online",
    links: part?.links ?? undefined,
  }));
  // Each machine's paired devices, this phone marked where it's one of them.
  const paired = new Map<string, (Device & { self: boolean })[]>();
  for (const { machine, part } of machines) {
    const list: (Device & { self: boolean })[] = [];
    for (const device of part?.devices ?? [])
      if (device.revokedAt === null) list.push({ ...device, self: device.id === part?.selfId });
    paired.set(machine.id, list);
  }
  const devices = fleetDevices(paired, linkDeviceIds(facts));
  // What this read of each answering machine returned; a field that failed is null in its part.
  const reads: FleetReads = {
    devices: new Set(machines.flatMap(({ machine, part }) => (part?.devices ? [machine.id] : []))),
    links: new Set(machines.flatMap(({ machine, part }) => (part?.links ? [machine.id] : []))),
  };
  const names = (id: string) => machines.find((entry) => entry.machine.id === id)?.machine.name;
  const machineRows = machines
    .map(({ input }) => machineNode(input, inSentence))
    .toSorted(byName)
    .map((node) => rowOf(node, node.id));
  const deviceRows = devices.toSorted(byName).map((device) => {
    // Judged against the machine that answers with its networks, else the first it's on.
    const on = device.on.map((entry) => machines.find((each) => each.machine.id === entry.machine));
    const home =
      on.find((entry) => entry?.input.status === "online" && entry.part?.networks) ?? on[0];
    const homeId = home?.machine.id ?? "";
    const input: FleetMapInput = {
      own: {
        id: homeId,
        name: home?.machine.name ?? "A machine",
        online: home?.input.status === "online",
        working: undefined,
      },
      enabled: home?.part?.remote.enabled ?? undefined,
      networks: home?.part?.networks ?? undefined,
      relayHost: undefined,
      machines: machines.filter((entry) => entry !== home).map((entry) => entry.input),
      account: [],
      devices: [],
      links: [],
      now,
    };
    const name = home?.machine.name ?? "the machine";
    const node = deviceNode(
      {
        key: device.key,
        name: device.name,
        on: device.on.map((entry) => entry.machine),
        lastSeenAt: device.lastSeenAt,
        expiresAt: device.expiresAt,
        self: device.self,
        readOnly: device.on.every((entry) => !entry.device.scopes.includes("operate")),
      },
      input,
      (id) => names(id) ?? "A machine",
      { name, here: `on ${name}` },
    );
    return rowOf(node, homeId, device);
  });
  const rows = [...machineRows, ...deviceRows];
  const problems = rows.filter((row) => row.problem).length;
  return {
    type: "fleetMap.view",
    // The phone itself is one of the devices when a machine names it; else count it here.
    summary:
      machines.length === 0
        ? "No machines paired yet."
        : summaryLine(rows.length + (devices.some((device) => device.self) ? 0 : 1), problems),
    problems,
    rows,
    reach: machines.flatMap(({ machine, part }) =>
      part
        ? [
            machineReach({
              id: machine.id,
              name: machine.name,
              part,
              devices,
              machines: facts,
              reads,
              viewer,
            }),
          ]
        : [],
    ),
  };
}
