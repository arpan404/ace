import {
  MachineCapability,
  type MachineAgentAccess,
  type MachineCall,
  type MachineGrantLevel,
  type MachineGrants,
  type MachineRefusal,
} from "@ace/protocol";

/*
 * Who may do what here, as pure rules (ADR 0105). The target reads the machine-wide switch, the
 * calling device's grants and pairing scope, and the calling thread's ceiling; these functions
 * decide. Nothing here reads a clock, a database or a setting.
 */

export type Risk = "read" | "operate";
const rank: Record<MachineGrantLevel, number> = { off: 0, read: 1, operate: 2 };
const lowest = (...levels: MachineGrantLevel[]): MachineGrantLevel =>
  levels.reduce((low, level) => (rank[level] < rank[low] ? level : low), "operate");

/** What each capability is called where the person reads it. */
export const capabilityNames: Record<MachineCapability, string> = {
  agents: "Agents",
  browser: "Browser",
  devices: "Simulators & emulators",
  screen: "Computer use",
  commands: "Commands",
};
/** Capabilities served through a guest session, not a provider thread. */
export const guestCapabilities = ["browser", "devices", "screen", "commands"] as const;

/**
 * A linked machine's level for each capability before the person sets it apart. Agents and
 * Browser follow this machine's switch, as the single setting did before grants existed.
 */
export function defaultGrants(master: MachineAgentAccess): MachineGrants {
  return { agents: master, browser: master, devices: "operate", screen: "off", commands: "off" };
}
export function grantsFor(
  master: MachineAgentAccess,
  chosen: Partial<MachineGrants>,
): MachineGrants {
  return { ...defaultGrants(master), ...chosen };
}

/** What the calling device's pairing lets it do anywhere here. */
export function pairingLevel(scope: { read: boolean; operate: boolean }): MachineGrantLevel {
  return scope.operate ? "operate" : scope.read ? "read" : "off";
}

export interface GrantFacts {
  /** This machine's `remote.agentAccess`: `off` closes it to every capability. */
  master: MachineAgentAccess;
  grants: MachineGrants;
  pairing: MachineGrantLevel;
  /** The calling thread's ceiling; absent from callers before ADR 0105, which is operate. */
  ceiling: "read" | "operate";
}

/** Each capability's level for this device: the lowest of switch, grant, pairing and ceiling. */
export function effectiveGrants(facts: GrantFacts): MachineGrants {
  const level = (capability: MachineCapability) =>
    facts.master === "off" ? "off" : lowest(facts.grants[capability], facts.pairing, facts.ceiling);
  return {
    agents: level("agents"),
    browser: level("browser"),
    devices: level("devices"),
    screen: level("screen"),
    commands: level("commands"),
  };
}

export type Decision =
  | { allow: true; level: "read" | "operate" }
  | { allow: false; code: MachineRefusal["error"]; message?: string };

const closed: Decision = {
  allow: false,
  code: "machine_opted_out",
  message:
    "Agents on other machines can't use this machine. The person can turn this on in Settings › Fleet.",
};

/**
 * Whether one call may run. `capability` undefined means any capability will do (describe): the
 * machine is open to this device when at least one capability is.
 */
export function decide(
  capability: MachineCapability | readonly MachineCapability[] | undefined,
  risk: Risk,
  facts: GrantFacts,
): Decision {
  if (facts.master === "off") return closed;
  if (facts.pairing === "off") return { allow: false, code: "machine_forbidden" };
  const levels = effectiveGrants(facts);
  const among =
    capability === undefined
      ? MachineCapability.options
      : typeof capability === "string"
        ? [capability]
        : capability;
  const level = among.reduce<MachineGrantLevel>(
    (high, entry) => (rank[levels[entry]] > rank[high] ? levels[entry] : high),
    "off",
  );
  if (level === "off") {
    if (capability === undefined) return closed;
    const name = typeof capability === "string" ? capabilityNames[capability] : "That";
    return {
      allow: false,
      code: "machine_forbidden",
      message: `${name} is off here for agents from that machine. The person can allow it in Settings › Fleet.`,
    };
  }
  if (risk === "operate" && level !== "operate")
    return {
      allow: false,
      code: "machine_forbidden",
      message:
        facts.ceiling === "read"
          ? "This thread is read-only, so it can't act on another machine."
          : "Agents from that machine may only read here. Use a read-only tool, or ask the person to allow more in Settings › Fleet.",
    };
  return { allow: true, level };
}

/**
 * The capability a call needs. Status and answers on a guest session belong to whichever guest
 * capability the device holds; on a delegated thread, to Agents.
 */
export function capabilityOf(
  call: MachineCall,
  guest: (threadId: string) => boolean,
): MachineCapability | readonly MachineCapability[] | undefined {
  switch (call.op) {
    case "describe":
      return undefined;
    case "status":
      return call.threadIds.every(guest) ? guestCapabilities : "agents";
    case "respond":
      return guest(call.threadId) ? guestCapabilities : "agents";
    case "browser.session":
      return call.capability ?? "browser";
    case "browser":
      return "browser";
    case "devices":
    case "screen":
    case "commands":
      return call.op;
    default:
      return "agents";
  }
}
