import { listNames } from "../list-names.ts";
import { formatAgo } from "../time.ts";
import { deviceKind, machineKind } from "./kinds.ts";
import { directWayOf, hostOf, pairedWays, serving } from "./networks.ts";
import {
  relayEnd,
  type FleetMapInput,
  type MapAccountInput,
  type MapDeviceInput,
  type MapFix,
  type MapMachineInput,
  type MapNode,
  type MapProblem,
  type MapWire,
  type WireKind,
  type ZoneId,
} from "./map-types.ts";

/*
 * One node of the Fleet map per machine or device, from what it reports (`fleet-map-facts.ts`
 * puts them together). Pure.
 */

export type NameOf = (id: string) => string;

export const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

const hour = 3_600_000;
const day = 24 * hour;
/** An account machine not seen for longer than this isn't answering. */
export const staleAfterMs = hour;

export const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;

/** "3 days", "5 hours", "40 minutes": a span in a wire's label. */
export function spanWords(ms: number): string {
  if (ms >= day) return plural(Math.round(ms / day), "day");
  if (ms >= hour) return plural(Math.round(ms / hour), "hour");
  return plural(Math.max(1, Math.round(ms / 60_000)), "minute");
}

const workingWords = (working: number | undefined) =>
  working ? `${plural(working, "agent")} working` : undefined;

const wayWords: Record<"tailscale" | "lan", string> = {
  tailscale: "Tailscale",
  lan: "local network",
};

const offline = (name: string): MapProblem => ({
  what: `${name} isn't answering.`,
  why: "It's asleep, off, or ace isn't running there. Work sent to it waits until it's back.",
  fixes: ["reconnect", "removeMachine"],
});

const needsCode = (name: string, fixes: readonly MapFix[]): MapProblem => ({
  what: `${name} asks for its machine code before this window can open it.`,
  why: "A code keeps a machine closed to a stolen account login. Enter it once per device.",
  fixes,
});

export function machineNode(machine: MapMachineInput): MapNode {
  const via = machine.via;
  const way = via?.kind === "direct" ? directWayOf(via.url) : undefined;
  const relayed = via !== undefined && via.kind !== "direct";
  const from = relayed ? relayEnd : "own";
  const reached =
    via === undefined
      ? "Unknown"
      : via.kind === "account"
        ? "ace relay"
        : via.kind === "relay"
          ? `Relay, ${hostOf(via.url) ?? "your relay"}`
          : `${way === "other" ? "Direct" : capitalize(wayWords[way ?? "lan"])}, ${hostOf(via.url) ?? via.url}`;
  const wayLabel = relayed
    ? via?.kind === "account"
      ? "ace relay"
      : "relay"
    : way === "other" || way === undefined
      ? (hostOf(via?.url) ?? "direct")
      : wayWords[way];
  const base = {
    id: machine.id,
    name: machine.name,
    role: "machine" as const,
    art: machineKind({ icon: machine.icon, name: machine.name }),
    working: undefined,
    zones: [] as ZoneId[],
    offer: undefined,
  };
  switch (machine.status) {
    case "online": {
      const working = machine.working;
      return {
        ...base,
        working,
        tone: "on",
        status: workingWords(working) ?? "Online",
        zones: way === "tailscale" ? ["tailnet"] : way === "lan" ? ["lan"] : [],
        wire: { from, kind: relayed ? "relay" : "direct", relayed, label: wayLabel },
        lines: [
          { label: "Reached", value: reached },
          { label: "Last seen", value: "Now" },
          ...(working === undefined
            ? []
            : [{ label: "Agents", value: working ? `${working} working now` : "None working" }]),
        ],
        problem: undefined,
      };
    }
    case "off":
      return {
        ...base,
        tone: "unknown",
        status: "Off on this device",
        wire: { from, kind: "unknown", relayed, label: "off" },
        lines: [{ label: "Reached", value: "Not while it's off here" }],
        problem: undefined,
      };
    case "connecting":
      return {
        ...base,
        tone: "unknown",
        status: "Connecting",
        wire: { from, kind: "unknown", relayed, label: "connecting" },
        lines: [{ label: "Reached", value: reached }],
        problem: undefined,
      };
    case "machine_code":
      return {
        ...base,
        tone: "warn",
        status: "Needs its code",
        wire: { from, kind: "needs", relayed, label: "needs code" },
        lines: [
          { label: "Reached", value: reached },
          { label: "Machine code", value: "Set, not entered here" },
        ],
        problem: needsCode(machine.name, ["enterCode"]),
      };
    case "auth_failed":
      return {
        ...base,
        tone: "bad",
        status: "Refused this window",
        wire: { from, kind: "broken", relayed, label: "refused" },
        lines: [{ label: "Reached", value: reached }],
        problem: {
          what: `${machine.name} refused this window.`,
          why: "Its pairing for this window ended there. Remove it, then add it again with a fresh pairing link.",
          fixes: ["removeMachine"],
        },
      };
    case "offline":
      return {
        ...base,
        tone: "bad",
        status: machine.failed ? "Couldn't reach it" : "Offline",
        wire: {
          from,
          kind: "broken",
          relayed,
          label: machine.failed ? "couldn't reach it" : "offline",
        },
        lines: [{ label: "Reached", value: `${reached}, last time` }],
        problem: offline(machine.name),
      };
  }
}

/** A wire through ace's relay. */
const wire = (kind: WireKind, label: string): MapWire => ({
  from: relayEnd,
  kind,
  relayed: true,
  label,
});

export function accountNode(machine: MapAccountInput, now: number): MapNode {
  const seen = machine.lastSeenAt > 0 ? formatAgo(machine.lastSeenAt, now) : "Not yet";
  const base = {
    id: machine.hostId,
    name: machine.name,
    role: "account" as const,
    art: machineKind({ name: machine.name, platform: machine.platform }),
    working: undefined,
    zones: [],
    offer: undefined,
  };
  const lines = [
    { label: "Reached", value: "ace relay" },
    { label: "Last seen", value: capitalize(seen) },
  ];
  const opening = machine.opening;
  if (opening?.kind === "asking")
    return {
      ...base,
      tone: "warn",
      status: "Needs its code",
      wire: wire("needs", "needs code"),
      lines: [...lines, { label: "Machine code", value: "Set, not entered here" }],
      problem: needsCode(machine.name, ["enterCode"]),
    };
  if (opening?.kind === "connecting")
    return {
      ...base,
      tone: "unknown",
      status: "Opening",
      wire: wire("unknown", "opening"),
      lines,
      problem: undefined,
    };
  if (opening?.kind === "open")
    return {
      ...base,
      tone: "on",
      status: "Online",
      wire: wire("relay", "ace relay"),
      lines,
      problem: undefined,
    };
  if (opening?.kind === "failed")
    return {
      ...base,
      tone: "bad",
      status: "Couldn't open it",
      wire: wire("broken", "can't open"),
      lines,
      problem: {
        what: `Couldn't open ${machine.name}.`,
        why: opening.message,
        fixes: ["openAccount", "forgetMachine"],
      },
    };
  const away = machine.lastSeenAt > 0 ? now - machine.lastSeenAt : 0;
  if (away > staleAfterMs)
    return {
      ...base,
      tone: "bad",
      status: `Not seen for ${spanWords(away)}`,
      wire: wire("broken", `not seen ${spanWords(away)}`),
      lines,
      problem: {
        what: `${machine.name} hasn't been seen for ${spanWords(away)}.`,
        why: "It's asleep, off, or ace isn't running there. Work sent to it waits until it's back.",
        fixes: ["openAccount", "forgetMachine"],
      },
    };
  // On the account and seen lately, but not opened here: nothing is known to be wrong or right.
  return {
    ...base,
    tone: "unknown",
    status: "On your ace account",
    wire: wire("relay", "ace relay"),
    lines,
    problem: undefined,
    offer: "openAccount",
  };
}

/** The machine a device is judged against, as its sentences name it. */
export interface DevicePlace {
  /** "this computer", or a machine's name. */
  name: string;
  /** "here", or "on studio". */
  here: string;
}

const thisComputer: DevicePlace = { name: "this computer", here: "here" };

/**
 * A paired device, judged against `input.own`: the web's own computer, or for a client with no
 * computer of its own (the phone) the machine it reaches the device through, named by `place`.
 */
export function deviceNode(
  device: MapDeviceInput,
  input: FleetMapInput,
  names: NameOf,
  place: DevicePlace = thisComputer,
): MapNode {
  const ownId = input.own.id;
  const opens =
    device.on.length > 1 && device.on.length === input.machines.length + 1
      ? "Every machine"
      : listNames(device.on.map(names));
  const lines = [
    { label: "Opens", value: `${opens}${device.readOnly ? ", view only" : ""}` },
    {
      label: "Last seen",
      value: device.self ? "Now, this device" : capitalize(formatAgo(device.lastSeenAt, input.now)),
    },
  ];
  const base = {
    id: `device:${device.key}`,
    name: device.name,
    role: "device" as const,
    art: deviceKind(device.name),
    working: undefined,
    zones: [],
    offer: undefined,
  };
  const status = device.self ? "this device" : "Paired";
  if (device.expiresAt !== null && device.expiresAt <= input.now)
    return {
      ...base,
      tone: "bad",
      status: "Access ended",
      wire: {
        from: device.on.includes(ownId) ? "own" : (device.on[0] ?? "own"),
        kind: "broken",
        relayed: false,
        label: "access ended",
      },
      lines,
      problem: {
        what: `${device.name}'s access has ended.`,
        why: "It was paired for a limited time. Remove it, then pair it again to keep using it.",
        fixes: ["removeDevice"],
      },
    };
  if (!device.on.includes(ownId)) {
    // Paired only with other machines: it reaches them, not this computer.
    const host = device.on[0] ?? "own";
    const online = input.machines.find((machine) => machine.id === host)?.status === "online";
    return {
      ...base,
      tone: online ? "on" : "unknown",
      status,
      wire: { from: host, kind: online ? "direct" : "unknown", relayed: false, label: "paired" },
      lines: [{ label: "Reached", value: `Through ${names(host)}` }, ...lines],
      problem: undefined,
    };
  }
  if (input.enabled === false)
    return {
      ...base,
      tone: "bad",
      status,
      wire: { from: "own", kind: "broken", relayed: false, label: "remote access off" },
      lines: [{ label: "Reached", value: "Nothing, remote access is off" }, ...lines],
      problem: {
        what: `${device.name} can't reach ${place.name}: remote access is off.`,
        why: `With remote access off, only ${place.name} can open it.`,
        fixes: ["turnOnRemote"],
      },
    };
  const networks = input.networks;
  if (input.enabled === undefined || !networks)
    return {
      ...base,
      tone: "unknown",
      status,
      wire: { from: "own", kind: "unknown", relayed: false, label: "paired" },
      lines,
      problem: undefined,
    };
  const ways = pairedWays(networks);
  if (ways.direct.length)
    return {
      ...base,
      tone: "on",
      status,
      // It's on whichever of this computer's networks reach it.
      zones: [
        ...(ways.direct.includes("local network") ? (["lan"] as const) : []),
        ...(ways.direct.includes("Tailscale") ? (["tailnet"] as const) : []),
      ],
      wire: { from: "own", kind: "direct", relayed: false, label: ways.direct.join(" or ") },
      lines: [{ label: "Reached", value: capitalize(ways.direct.join(" or ")) }, ...lines],
      problem: undefined,
    };
  if (ways.relay)
    return {
      ...base,
      tone: "on",
      status,
      wire: { from: relayEnd, kind: "relay", relayed: true, label: "relay" },
      lines: [{ label: "Reached", value: "Your relay" }, ...lines],
      problem: undefined,
    };
  return {
    ...base,
    tone: "warn",
    status,
    wire: { from: "own", kind: "broken", relayed: false, label: "local network off" },
    lines: [{ label: "Reached", value: "Local network, Tailscale or a relay" }, ...lines],
    problem: {
      what: `${device.name} was paired with a code, and the networks paired devices use are off ${place.here}.`,
      why: `Paired devices reach ${place.name} over the local network, Tailscale or your relay. Signing in on it reaches every machine from anywhere.`,
      fixes: ["turnOnLan", "askSignIn"],
    },
  };
}

export function ownNode(input: FleetMapInput): MapNode {
  const { own, networks } = input;
  const onRelay = networks !== undefined && (serving(networks.account) || serving(networks.relay));
  const reached = networks
    ? [
        serving(networks.account) ? "ace relay" : undefined,
        serving(networks.relay) && networks.relay.address !== networks.account.address
          ? "your relay"
          : undefined,
        serving(networks.tailscale) ? "Tailscale" : undefined,
        serving(networks.lan) ? "local network" : undefined,
      ].filter((way) => way !== undefined)
    : [];
  const working = own.online ? own.working : undefined;
  const off = input.enabled === false;
  return {
    id: own.id,
    name: own.name,
    role: "own",
    art: machineKind({ icon: own.icon, name: own.name }),
    tone: !own.online ? "unknown" : off ? "warn" : "on",
    status: workingWords(working) ?? "this computer",
    working,
    zones: networks
      ? [
          ...(serving(networks.lan) ? (["lan"] as const) : []),
          ...(serving(networks.tailscale) ? (["tailnet"] as const) : []),
        ]
      : [],
    wire: onRelay
      ? {
          from: relayEnd,
          kind: "relay",
          relayed: true,
          label: serving(networks.account) ? "ace relay" : "relay",
        }
      : undefined,
    lines: [
      {
        label: "Reached",
        value: off
          ? "Remote access is off"
          : networks
            ? reached.length
              ? capitalize(listNames(reached))
              : "Nothing yet"
            : "Checking",
      },
      ...(networks ? [{ label: "Local net", value: serving(networks.lan) ? "On" : "Off" }] : []),
      ...(working === undefined
        ? []
        : [{ label: "Agents", value: working ? `${working} working now` : "None working" }]),
    ],
    problem: off
      ? {
          what: "Remote access is off, so nothing else can open this computer.",
          why: "Your other machines and devices reach it again once it's on.",
          fixes: ["turnOnRemote"],
        }
      : undefined,
    offer: undefined,
  };
}
