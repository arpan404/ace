import { z } from "zod";
import { DeviceId } from "./ids.ts";

/**
 * `desktop` and `user-browser` are local-only credentials the daemon mints for its own desktop app
 * and for the "Use my Chrome" native host (ADR 0084); they are never paired.
 */
export const DeviceScope = z.enum([
  "read",
  "operate",
  "admin",
  "desktop",
  "projects",
  "accounts",
  "user-browser",
]);
export type DeviceScope = z.infer<typeof DeviceScope>;
const timestamp = z.number().int().nonnegative();
export const Device = z.object({
  id: DeviceId,
  name: z.string().min(1).max(256),
  scopes: z.array(DeviceScope).min(1).max(7),
  createdAt: timestamp,
  lastSeenAt: timestamp,
  revokedAt: timestamp.nullable(),
  /** When this device's access ends on its own; null or absent: until revoked. */
  expiresAt: timestamp.nullable().optional(),
});
export type Device = z.infer<typeof Device>;
const minute = 60_000;
const day = 24 * 60 * minute;
/** How long a pairing link can be redeemed: 5 minutes (the default), 1 hour, 1 day or 7 days. */
const PairingLinkTtl = z.union([
  z.literal(5 * minute),
  z.literal(60 * minute),
  z.literal(day),
  z.literal(7 * day),
]);
export type PairingLinkTtl = z.infer<typeof PairingLinkTtl>;
/** How long a device paired from a link keeps access: 1, 7 or 30 days. */
const DeviceAccessTtl = z.union([z.literal(day), z.literal(7 * day), z.literal(30 * day)]);
export type DeviceAccessTtl = z.infer<typeof DeviceAccessTtl>;
const PairingScope = DeviceScope.exclude(["desktop", "user-browser"]);
export type PairingScope = z.infer<typeof PairingScope>;
export const PairingRequest = z.object({
  scopes: z.array(PairingScope).min(1).max(5).default(["read", "operate"]),
  /** The redeemed device is named this instead of the name it sends. */
  label: z.string().min(1).max(64).optional(),
  ttlMs: PairingLinkTtl.optional(),
  /** Omitted or null: the paired device keeps access until revoked. */
  deviceTtlMs: DeviceAccessTtl.nullable().optional(),
});
export type PairingRequest = z.input<typeof PairingRequest>;
/** A pairing link not yet redeemed or expired. Never carries its code or URL. */
export const PendingPairing = z.object({
  id: z.string().min(1).max(128),
  label: z.string().min(1).max(64).optional(),
  scopes: z.array(PairingScope).min(1).max(5),
  expiresAt: timestamp,
  deviceTtlMs: DeviceAccessTtl.optional(),
});
export type PendingPairing = z.infer<typeof PendingPairing>;
export const PairingRedemption = z.object({
  code: z.string().min(1).max(256),
  name: z.string().min(1).max(256),
});
export const PairingResponse = z.object({
  url: z.url(),
  expiresAt: timestamp,
  /** The pending link's id, to cancel it. Absent from older daemons. */
  id: z.string().min(1).max(128).optional(),
});
export const DeviceToken = z.string().regex(/^[0-9a-f]{64}$/);
export type DeviceToken = z.infer<typeof DeviceToken>;
export const DeviceCredential = z.object({
  device: Device,
  token: DeviceToken,
});
export type DeviceCredential = z.infer<typeof DeviceCredential>;
export const SocketTicket = z.object({
  ticket: z.string().regex(/^[0-9a-f]{64}$/),
  expiresAt: timestamp,
});

/** Current network resources and launch overrides, independent of saved preferences. */
export const RemoteAccessStatus = z.object({
  enabled: z.boolean(),
  transport: z.enum(["local", "lan", "tailscale", "relay"]),
  listenOverride: z.enum(["local", "lan", "tailscale"]).nullable(),
  relayOverride: z.boolean(),
  error: z.string().max(256).optional(),
  /**
   * While the relay runs: where a paired client opens channels through it (devices, files),
   * the relay host key it pins, and the daemon identity the channel's welcome names.
   */
  relay: z
    .object({
      url: z.string().max(2048),
      fingerprint: z.string().regex(/^[A-Z2-7]{52}$/),
      hostId: z.string().min(1).max(256),
    })
    .optional(),
});
export type RemoteAccessStatus = z.infer<typeof RemoteAccessStatus>;
