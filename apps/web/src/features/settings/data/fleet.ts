import type { ClientApi } from "@ace/client";
import type { Device, FleetLink, PairingScope } from "@ace/protocol";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { Machine } from "@/lib/machines.ts";

/*
 * The fleet: every machine this window reaches, linked so each one's agents can use the others
 * (ADR 0078), and the phones and browsers paired to each. Everything here goes through each
 * machine's own client (`fleet.request`), so a remote machine's links and devices are its own,
 * never this window's daemon's. Each operation needs administrator access on that machine.
 */

type Operation = Extract<
  Parameters<ClientApi["request"]>[0],
  { type: "fleet.request" }
>["operation"];

async function fleet(client: ClientApi, operation: Operation) {
  const reply = await client.request({ type: "fleet.request", operation });
  return reply.result;
}

/** A failure a machine reports, in words a person acts on. */
export function fleetProblem(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  if (code === "forbidden")
    return "This window doesn't have administrator access to this machine. Pair it again as Administrator to manage it.";
  return error instanceof Error && error.message ? error.message : "That machine didn't answer.";
}

export async function machineLinks(client: ClientApi): Promise<FleetLink[]> {
  const result = await fleet(client, { op: "links" });
  return result.kind === "links" ? result.links : [];
}

/** A paired device; `self` marks the one this window connects as. */
export type PairedDevice = Device & { self?: boolean };

export async function machineDevices(client: ClientApi): Promise<PairedDevice[]> {
  const result = await fleet(client, { op: "devices" });
  if (result.kind !== "devices") return [];
  // Local credentials (the desktop app, "Use my Chrome") are not paired devices.
  return result.devices
    .filter(
      (device) =>
        device.revokedAt === null &&
        !device.scopes.includes("desktop") &&
        !device.scopes.includes("user-browser"),
    )
    .map((device) =>
      device.id === result.selfId ? Object.assign(device, { self: true }) : device,
    );
}

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

export interface PairingOptions {
  scopes: PairingScope[];
  /** Names the device that pairs, instead of the name it gives itself. */
  label?: string | undefined;
  ttlMs?: LinkLifetime;
  deviceTtlMs?: DeviceLifetime;
}

export async function createPairing(client: ClientApi, options: PairingOptions) {
  const label = options.label?.trim();
  const result = await fleet(client, {
    op: "pairing",
    scopes: options.scopes,
    ...(label ? { label } : {}),
    ...(options.ttlMs ? { ttlMs: options.ttlMs } : {}),
    ...(options.deviceTtlMs ? { deviceTtlMs: options.deviceTtlMs } : {}),
  });
  if (result.kind !== "pairing") throw new Error("That machine didn't make a pairing.");
  return result;
}

/** Links made on this machine that no device has used yet (never their code). */
export async function pendingPairings(client: ClientApi) {
  const result = await fleet(client, { op: "pairings" });
  return result.kind === "pairings" ? result.pairings : [];
}

export async function cancelPairing(client: ClientApi, id: string): Promise<void> {
  await fleet(client, { op: "cancelPairing", id });
}

export async function revokeDevice(client: ClientApi, deviceId: string): Promise<void> {
  await fleet(client, { op: "revoke", deviceId });
}

/** What agents on a linked machine may do on the machine it reaches. */
export type LinkAccess = "read" | "operate";

/**
 * Link `from` to `to`: `to` issues a one-time pairing for an agent device (never administrator)
 * and `from` redeems it and keeps it as a link. Agents on `from` then reach `to`, up to the lower
 * of this grant and `to`'s own "Agents from other machines" setting.
 */
export async function linkMachine(from: Machine, to: Machine, access: LinkAccess) {
  if (!from.client || !to.client) throw new Error("Both machines must be online to link them.");
  const pairing = await createPairing(to.client, {
    scopes: access === "operate" ? ["read", "operate"] : ["read"],
  });
  const result = await fleet(from.client, {
    op: "link",
    pairingUrl: pairing.url,
    hostId: to.id,
    name: to.name,
  });
  if (result.kind !== "linked") throw new Error(`${from.name} didn't keep the link.`);
  return result.link;
}

/**
 * Unlink `from` from `to`: `from` forgets the link, and `to` revokes the device `from` used, so
 * the link can't come back without pairing again. Revoking is best effort while `to` is offline;
 * the forgotten link already stops `from`'s agents.
 */
export async function unlinkMachine(from: Machine, to: Machine, link: FleetLink) {
  if (!from.client) throw new Error(`${from.name} must be online to unlink it.`);
  await fleet(from.client, { op: "unlink", hostId: to.id });
  if (to.client) await revokeDevice(to.client, link.deviceId).catch(() => undefined);
}

export const fleetKeys = {
  links: (machine: string) => ["fleet", "links", machine] as const,
  devices: (machine: string) => ["fleet", "devices", machine] as const,
  pairings: (machine: string) => ["fleet", "pairings", machine] as const,
};

/** Each online machine's open pairing links, keyed by machine id. */
export function useFleetPairings(machines: readonly Machine[]) {
  const results = useQueries({
    queries: machines.map((machine) => ({
      queryKey: fleetKeys.pairings(machine.id),
      queryFn: () => (machine.client ? pendingPairings(machine.client) : Promise.resolve([])),
      enabled: machine.client !== undefined,
      refetchInterval: 30_000,
    })),
  });
  return new Map(machines.map((machine, index) => [machine.id, results[index]]));
}

/** Each online machine's links, keyed by machine id. Offline machines have none to read. */
export function useFleetLinks(machines: readonly Machine[]) {
  const results = useQueries({
    queries: machines.map((machine) => ({
      queryKey: fleetKeys.links(machine.id),
      queryFn: () => (machine.client ? machineLinks(machine.client) : Promise.resolve([])),
      enabled: machine.client !== undefined,
      refetchInterval: 15_000,
    })),
  });
  return new Map(machines.map((machine, index) => [machine.id, results[index]]));
}

/** Each online machine's paired devices, keyed by machine id. */
export function useFleetDevices(machines: readonly Machine[]) {
  const results = useQueries({
    queries: machines.map((machine) => ({
      queryKey: fleetKeys.devices(machine.id),
      queryFn: () => (machine.client ? machineDevices(machine.client) : Promise.resolve([])),
      enabled: machine.client !== undefined,
    })),
  });
  return new Map(machines.map((machine, index) => [machine.id, results[index]]));
}

export function useMachineDevices(machine: Machine | undefined) {
  return useQuery({
    queryKey: fleetKeys.devices(machine?.id ?? ""),
    queryFn: () => (machine?.client ? machineDevices(machine.client) : Promise.resolve([])),
    enabled: machine?.client !== undefined,
  });
}
