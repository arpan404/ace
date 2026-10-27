import { z } from "zod";
import { DeviceId, HostId } from "./ids.ts";
import { Device, PairingRequest, PendingPairing } from "./remote.ts";
import { MachineAgentAccess } from "./machine-calls.ts";
import { MachineCapability, MachineDeviceGrants, MachineGrantLevel } from "./machine-grants.ts";

const id = z.string().min(1).max(128);
const timestamp = z.number().int().nonnegative();

/**
 * This machine's link to another of the person's machines: the device credential it holds there,
 * which agents here use as `machine` (ADR 0078). Never carries the credential's token.
 */
export const FleetLink = z.object({
  /** The other machine's host id, once known. */
  hostId: HostId.optional(),
  /** The name agents pass as `machine`. */
  profile: z.string().min(1).max(64),
  /** The other machine's display name. */
  name: z.string().min(1).max(256),
  origin: z.string().min(1).max(2048),
  /** This machine's device id on the other machine, so a client can revoke it there. */
  deviceId: DeviceId,
  /** `refused`: paired, but that machine doesn't let agents from other machines in. */
  status: z.enum(["online", "offline", "refused"]),
  access: z.enum(["read", "operate"]).optional(),
  /**
   * Whether this machine's device there holds `projects` (ADR 0063). Transfers need it with
   * `operate` (ADR 0101); absent when unknown.
   */
  projects: z.boolean().optional(),
});
export type FleetLink = z.infer<typeof FleetLink>;

const FleetOperation = z.discriminatedUnion("op", [
  /** This machine's links to other machines, each checked once. */
  z.object({ op: z.literal("links") }),
  /** Redeem a pairing link another machine issued and keep it as a link to that machine. */
  z.object({
    op: z.literal("link"),
    /** The https link with its code after `#`, as the other machine issued it. */
    pairingUrl: z.string().min(1).max(4096),
    hostId: HostId,
    name: z.string().min(1).max(256),
  }),
  z.object({ op: z.literal("unlink"), hostId: HostId }),
  /** Issue a one-time pairing link on this machine. */
  PairingRequest.extend({ op: z.literal("pairing") }),
  /** This machine's pairing links no device has used yet. */
  z.object({ op: z.literal("pairings") }),
  z.object({ op: z.literal("cancelPairing"), id }),
  /** This machine's paired devices, as `GET /v1/devices` lists them. */
  z.object({ op: z.literal("devices") }),
  z.object({ op: z.literal("revoke"), deviceId: DeviceId }),
  /** Revoke every paired device except the caller's own and local credentials. */
  z.object({ op: z.literal("revokeOthers") }),
  /** What each paired device's agents may do here, per capability (ADR 0105). */
  z.object({ op: z.literal("grants") }),
  /** Set one capability's level for one paired device; it applies to the next call. */
  z.object({
    op: z.literal("grant"),
    deviceId: DeviceId,
    capability: MachineCapability,
    level: MachineGrantLevel,
  }),
]);
export type FleetOperation = z.infer<typeof FleetOperation>;

export const FleetRequest = z.object({
  type: z.literal("fleet.request"),
  requestId: id,
  operation: FleetOperation,
});
export type FleetRequest = z.infer<typeof FleetRequest>;

const FleetOutcome = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("links"), links: z.array(FleetLink).max(64) }),
  z.object({ kind: z.literal("linked"), link: FleetLink }),
  z.object({ kind: z.literal("unlinked") }),
  z.object({
    kind: z.literal("pairing"),
    id,
    url: z.url(),
    code: z.string().min(1).max(256),
    expiresAt: timestamp,
  }),
  z.object({ kind: z.literal("pairings"), pairings: z.array(PendingPairing).max(100) }),
  z.object({ kind: z.literal("pairingCancelled") }),
  z.object({
    kind: z.literal("devices"),
    devices: z.array(Device).max(10_000),
    /** The calling device's id when it is one of `devices`. */
    selfId: DeviceId.optional(),
  }),
  z.object({
    kind: z.literal("grants"),
    /** This machine's `remote.agentAccess`: `off` closes it to every capability. */
    master: MachineAgentAccess,
    devices: z.array(MachineDeviceGrants).max(1000),
  }),
  /** `count`: how many devices `revokeOthers` revoked. */
  z.object({ kind: z.literal("revoked"), count: z.number().int().nonnegative().optional() }),
]);
export type FleetOutcome = z.infer<typeof FleetOutcome>;

export const FleetResult = z.object({
  type: z.literal("fleet.result"),
  requestId: id,
  result: FleetOutcome,
});
export type FleetResult = z.infer<typeof FleetResult>;
