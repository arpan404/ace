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
});
export type Device = z.infer<typeof Device>;
export const PairingRequest = z.object({
  scopes: z
    .array(DeviceScope.exclude(["desktop", "user-browser"]))
    .min(1)
    .max(5)
    .default(["read", "operate"]),
});
export const PairingRedemption = z.object({
  code: z.string().min(1).max(256),
  name: z.string().min(1).max(256),
});
export const PairingResponse = z.object({ url: z.url(), expiresAt: timestamp });
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
