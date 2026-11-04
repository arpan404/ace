import type { MachineIconKind, RemoteNetworks } from "@ace/protocol";
import type { MachineStatus, MachineVia } from "@/lib/machines.ts";

/*
 * What the Fleet map draws, from what the fleet reports: each machine and device as a node with
 * its state, the one wire that says how it reaches this computer, the networks it sits in, and
 * what's wrong with the fix for it. Pure: the page passes in what it read. Anything not read yet
 * is neutral, never broken, and a machine's agents are counted only while it reports them.
 */

export type MapArt = "laptop" | "desktop" | "server" | "phone" | "tablet" | "browser";
/** `unknown`: not read yet, or nothing to say; drawn neutral. */
export type MapTone = "on" | "warn" | "bad" | "unknown";
/** direct: LAN or Tailscale; relay: through a relay; needs: waits on the person; broken: down. */
export type WireKind = "direct" | "relay" | "needs" | "broken" | "unknown";
export type ZoneId = "lan" | "tailnet";
/** The relay cloud, as a wire's far end. */
export const relayEnd = "relay";

/** The actions a node's panel offers, each wired to the real flow by the page. */
export type MapFix =
  | "enterCode"
  | "openAccount"
  | "turnOnLan"
  | "turnOnRemote"
  | "reconnect"
  | "removeMachine"
  | "forgetMachine"
  | "removeDevice"
  | "askSignIn";

export interface MapMachineInput {
  id: string;
  name: string;
  icon?: MachineIconKind | undefined;
  status: MachineStatus;
  failed: boolean;
  via: MachineVia | undefined;
  /** Agents working there now; undefined while its threads aren't known. */
  working: number | undefined;
}

/** How opening an account machine from this window is going, once asked to. */
export type AccountOpening =
  | { kind: "connecting" }
  | { kind: "asking" }
  | { kind: "open" }
  | { kind: "failed"; message: string };

export interface MapAccountInput {
  hostId: string;
  name: string;
  platform: string;
  lastSeenAt: number;
  opening: AccountOpening | undefined;
}

export interface MapDeviceInput {
  key: string;
  name: string;
  /** The machines it's paired with. */
  on: readonly string[];
  lastSeenAt: number;
  expiresAt: number | null;
  self: boolean;
  readOnly: boolean;
}

export interface FleetMapInput {
  own: {
    id: string;
    name: string;
    icon?: MachineIconKind | undefined;
    online: boolean;
    working: number | undefined;
  };
  /** This computer's remote access switch; undefined until read. */
  enabled: boolean | undefined;
  /** This computer's networks; undefined until read or from an older daemon. */
  networks: RemoteNetworks | undefined;
  /** ace's relay host when this build has one. */
  relayHost: string | undefined;
  machines: readonly MapMachineInput[];
  account: readonly MapAccountInput[];
  devices: readonly MapDeviceInput[];
  /** Machine pairs holding a link in at least one direction. */
  links: readonly { from: string; to: string }[];
  now: number;
}

export interface MapWire {
  /** The other end: a machine's id or `relayEnd`. */
  from: string;
  kind: WireKind;
  /** Drawn dashed: it runs through a relay (a needs or broken wire can too). */
  relayed: boolean;
  label: string;
}

export interface MapProblem {
  what: string;
  why: string;
  fixes: readonly MapFix[];
}

export interface MapNode {
  id: string;
  name: string;
  role: "own" | "machine" | "account" | "device";
  art: MapArt;
  tone: MapTone;
  /** Under its name: its state, or "N agents working". */
  status: string;
  working: number | undefined;
  zones: readonly ZoneId[];
  /** How it reaches this computer; this computer's own wire is to the relay, when it's on one. */
  wire: MapWire | undefined;
  lines: readonly { label: string; value: string }[];
  problem: MapProblem | undefined;
  /** An action that isn't a fix: opening an account machine that hasn't been opened. */
  offer: MapFix | undefined;
}

export interface MapZone {
  id: ZoneId;
  label: string;
  sub: string | undefined;
}

export interface FleetMap {
  nodes: readonly MapNode[];
  zones: readonly MapZone[];
  relay: { label: string; host: string } | undefined;
  agentLinks: readonly { a: string; b: string }[];
  problems: number;
  summary: string;
}
