import type { Device, FleetLink } from "@ace/protocol";

/*
 * Who reaches whom in the fleet, worked out from each machine's own list of links. Pure: the
 * page passes in what it read, so the rules can be tested directly.
 */

export interface FleetMachineFacts {
  id: string;
  name: string;
  online: boolean;
  /** Its links, once read; undefined while unread, offline or refused. */
  links: readonly FleetLink[] | undefined;
}

/** One direction between two machines: whether `from`'s agents can use `to`. */
export type Reach =
  /** `from` holds a link to `to`, and `to` lets agents in at this level. */
  | { kind: "linked"; access: "read" | "operate" }
  /** Linked, but `to` doesn't let agents from other machines in. */
  | { kind: "closed" }
  /** Linked, but `to` couldn't be reached when `from` last tried. */
  | { kind: "unreachable" }
  | { kind: "missing" }
  /** `from`'s links can't be read (offline, or no administrator access). */
  | { kind: "unknown" };

export function reach(from: FleetMachineFacts, to: FleetMachineFacts): Reach {
  if (!from.links) return { kind: "unknown" };
  const link = from.links.find((entry) => entry.hostId === to.id);
  if (!link) return { kind: "missing" };
  if (link.status === "refused") return { kind: "closed" };
  if (link.status === "offline") return { kind: "unreachable" };
  return { kind: "linked", access: link.access ?? "read" };
}

/** A pair of machines that should be linked in at least one direction and isn't. */
export interface LinkGap {
  from: string;
  to: string;
}

/**
 * Directions to link: between every two online machines whose links are known, each direction
 * that has no link. Offline machines and unreadable lists are left out: nothing can be done there
 * now, and guessing would offer a Link button that fails.
 */
export function linkGaps(machines: readonly FleetMachineFacts[]): LinkGap[] {
  const gaps: LinkGap[] = [];
  for (const from of machines)
    for (const to of machines)
      if (from.id !== to.id && from.online && to.online && reach(from, to).kind === "missing")
        gaps.push({ from: from.id, to: to.id });
  return gaps;
}

/** The machines `machine` is missing a link with, in either direction. */
export function unlinkedWith(machine: string, gaps: readonly LinkGap[]): string[] {
  const ids = new Set<string>();
  for (const gap of gaps) {
    if (gap.from === machine) ids.add(gap.to);
    if (gap.to === machine) ids.add(gap.from);
  }
  return [...ids];
}

/** A machine's missing links, by direction: links are kept per direction, so one can be missing. */
export interface MachineGaps {
  /** No link either way. */
  unlinked: string[];
  /** It links to these, but they hold no link back: they can't use it. */
  notUsedBy: string[];
  /** These link to it, but it holds no link to them: it can't use them. */
  cantUse: string[];
}

export function machineGaps(machine: string, gaps: readonly LinkGap[]): MachineGaps {
  const to = new Set(gaps.filter((gap) => gap.from === machine).map((gap) => gap.to));
  const from = new Set(gaps.filter((gap) => gap.to === machine).map((gap) => gap.from));
  return {
    unlinked: [...to].filter((id) => from.has(id)),
    notUsedBy: [...from].filter((id) => !to.has(id)),
    cantUse: [...to].filter((id) => !from.has(id)),
  };
}

/**
 * The device ids machines use to reach each other. Each machine lists these among its paired
 * devices; they are links, not phones or browsers, so the device list leaves them out.
 */
export function linkDeviceIds(machines: readonly FleetMachineFacts[]): ReadonlySet<string> {
  return new Set(machines.flatMap((machine) => (machine.links ?? []).map((link) => link.deviceId)));
}

/** One phone, tablet or browser across the fleet: the same device paired with several machines. */
export interface FleetDevice {
  /** Stable for the row: its name, since each machine gives it a different id. */
  key: string;
  name: string;
  /** Each machine it's paired with, and its device record there. */
  on: { machine: string; device: Device }[];
  lastSeenAt: number;
  /** The soonest expiry across its machines, if any expire. */
  expiresAt: number | null;
  /** This window connects as this device: revoking it disconnects the window. */
  self: boolean;
}

/**
 * Paired devices across machines, joined by name: a device pairs with each machine on its own,
 * so the same phone has a record on each. Machine links are left out. Newest seen first.
 */
export function fleetDevices(
  byMachine: ReadonlyMap<string, readonly (Device & { self?: boolean })[]>,
  links: ReadonlySet<string>,
): FleetDevice[] {
  const joined = new Map<string, FleetDevice>();
  for (const [machine, devices] of byMachine)
    for (const device of devices) {
      if (links.has(device.id)) continue;
      const entry = joined.get(device.name) ?? {
        key: device.name,
        name: device.name,
        on: [],
        lastSeenAt: 0,
        expiresAt: null,
        self: false,
      };
      entry.on.push({ machine, device });
      if (device.self) entry.self = true;
      entry.lastSeenAt = Math.max(entry.lastSeenAt, device.lastSeenAt);
      const expires = device.expiresAt ?? null;
      if (expires !== null)
        entry.expiresAt = entry.expiresAt === null ? expires : Math.min(entry.expiresAt, expires);
      joined.set(device.name, entry);
    }
  return [...joined.values()].toSorted((a, b) => b.lastSeenAt - a.lastSeenAt);
}
