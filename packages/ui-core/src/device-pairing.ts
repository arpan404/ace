import type { Device, DeviceScope, FleetOperation, PairingScope } from "@ace/protocol";

/*
 * Pairing other devices with a machine and the devices already paired, as every client words
 * and builds them: access levels and what each allows, the extra grants, how long a link and a
 * device's access last, the grant a device holds in words, and the `fleet.request` a pairing
 * form sends. The web's Fleet settings and the phone's Devices page both draw from these.
 */

const scopeLabels: Record<DeviceScope, string> = {
  read: "View only",
  operate: "View and act",
  admin: "Administrator",
  projects: "Projects",
  accounts: "Accounts",
  desktop: "Desktop",
  "user-browser": "Use my Chrome",
};

export type DeviceAccess = "operate" | "read" | "admin";

/** The access levels a pairing offers, in the order a form lists them. */
export const deviceAccessLevels: readonly {
  value: DeviceAccess;
  label: string;
  description: string;
  scopes: readonly PairingScope[];
}[] = [
  {
    value: "operate",
    label: scopeLabels.operate,
    description: "Follow threads, answer approvals, send messages and stop agents.",
    scopes: ["read", "operate"],
  },
  {
    value: "read",
    label: scopeLabels.read,
    description: "Follow threads and read transcripts. Nothing it does changes anything.",
    scopes: ["read"],
  },
  {
    value: "admin",
    label: scopeLabels.admin,
    description: "Everything, plus settings, pairing, revoking and computer use.",
    scopes: ["read", "operate", "admin"],
  },
];

/** Grants apart from the access level, each its own switch. */
export const advancedPairingScopes: readonly {
  value: "projects" | "accounts";
  label: string;
  what: string;
}[] = [
  { value: "projects", label: "Projects", what: "Add and remove project folders." },
  { value: "accounts", label: "Accounts", what: "Add and remove provider accounts." },
];

export const linkLifetimes = [
  { value: 5 * 60_000, label: "5 minutes" },
  { value: 60 * 60_000, label: "1 hour" },
  { value: 24 * 60 * 60_000, label: "1 day" },
  { value: 7 * 24 * 60 * 60_000, label: "7 days" },
] as const;
export type LinkLifetime = (typeof linkLifetimes)[number]["value"];

export const deviceLifetimes = [
  { value: 0, label: "Until revoked" },
  { value: 24 * 60 * 60_000, label: "1 day" },
  { value: 7 * 24 * 60 * 60_000, label: "7 days" },
  { value: 30 * 24 * 60 * 60_000, label: "30 days" },
] as const;
/** 0: the device keeps access until it is revoked. */
export type DeviceLifetime = (typeof deviceLifetimes)[number]["value"];

/** The grant a device actually holds, in words, including independent extra grants. */
export function deviceScopeLabels(scopes: readonly DeviceScope[]): string {
  const access = scopes.includes("admin")
    ? "admin"
    : scopes.includes("operate")
      ? "operate"
      : scopes.includes("read")
        ? "read"
        : undefined;
  const granted = [
    ...(access ? [scopeLabels[access]] : []),
    ...scopes
      .filter((scope) => !["read", "operate", "admin"].includes(scope))
      .map((scope) => scopeLabels[scope]),
  ];
  return granted.length ? granted.join(", ") : "No access";
}

/** What a pairing form holds. */
export interface PairingDraft {
  access: DeviceAccess;
  extras: readonly ("projects" | "accounts")[];
  /** Names the device that pairs, instead of the name it gives itself. */
  label?: string | undefined;
  ttlMs?: LinkLifetime | undefined;
  deviceTtlMs?: DeviceLifetime | undefined;
}

/** The `fleet.request` operation a pairing form sends. */
export function pairingOperation(draft: PairingDraft): Extract<FleetOperation, { op: "pairing" }> {
  const level = deviceAccessLevels.find((entry) => entry.value === draft.access);
  const label = draft.label?.trim();
  return {
    op: "pairing",
    scopes: [...new Set([...(level?.scopes ?? ["read"]), ...draft.extras])],
    ...(label ? { label: label.slice(0, 64) } : {}),
    ...(draft.ttlMs ? { ttlMs: draft.ttlMs } : {}),
    ...(draft.deviceTtlMs ? { deviceTtlMs: draft.deviceTtlMs } : {}),
  };
}

/**
 * The devices a person paired: revoked ones and the machine's local credentials (the desktop
 * app, "Use my Chrome") left out.
 */
export function pairedDevices(devices: readonly Device[]): Device[] {
  return devices.filter(
    (device) =>
      device.revokedAt === null &&
      !device.scopes.includes("desktop") &&
      !device.scopes.includes("user-browser"),
  );
}

/** A fleet refusal's code in words a person acts on. */
export function fleetRefusal(code: string, machine: string): string {
  switch (code) {
    case "forbidden":
      return `This device doesn't have administrator access to ${machine}. Pair it again as Administrator to manage it.`;
    case "unavailable":
      return `Turn on remote access on ${machine}.`;
    case "busy":
      return `${machine} has too many pairing links open. Cancel one first.`;
    case "offline":
    case "timeout":
      return `${machine} didn't answer. Check that it's online and try again.`;
    default:
      return `That didn't work on ${machine}. Try again.`;
  }
}

/** What agents on a linked machine may do on the machine it reaches. */
export type LinkAccess = "read" | "operate";

/** The scopes the reached machine's pairing grants a link: never administrator. */
export function linkScopes(access: LinkAccess): PairingScope[] {
  return access === "operate" ? ["read", "operate"] : ["read"];
}

/** Why `to` couldn't make a pairing link for a link, in words the person acts on. */
export function linkPairingProblem(code: string, to: string): string {
  if (code === "unavailable") return `Turn on remote access on ${to}.`;
  if (code === "forbidden")
    return `This device doesn't have administrator access to ${to}. Pair it again as Administrator.`;
  if (code === "busy") return `${to} has too many pairing links open. Cancel one first.`;
  return `${to} didn't make a pairing link.`;
}

/** Why `from` couldn't use `to`'s pairing link, in words the person acts on. */
export function linkRedeemProblem(code: string, from: string, to: string): string {
  if (code === "unavailable")
    return `${from} couldn't reach ${to}. Check that both are on the same network (Tailscale or LAN) and that remote access is on.`;
  if (code === "refused") return `${to} didn't accept ${from}. Try again.`;
  if (code === "limit") return `${from} has 64 links already. Remove one first.`;
  if (code === "forbidden")
    return `This device doesn't have administrator access to ${from}. Pair it again as Administrator.`;
  return `${from} didn't link to ${to}.`;
}
