import { z } from "zod";
import { DeviceId } from "./ids.ts";

export const DeviceScope = z.enum(["read", "operate", "admin", "desktop", "projects", "accounts"]);
export type DeviceScope = z.infer<typeof DeviceScope>;
const timestamp = z.number().int().nonnegative();
export const Device = z.object({
  id: DeviceId,
  name: z.string().min(1).max(256),
  scopes: z.array(DeviceScope).min(1).max(6),
  createdAt: timestamp,
  lastSeenAt: timestamp,
  revokedAt: timestamp.nullable(),
});
export type Device = z.infer<typeof Device>;
export const PairingRequest = z.object({
  scopes: z
    .array(DeviceScope.exclude(["desktop"]))
    .min(1)
    .max(5)
    .default(["read", "operate"]),
});
export const PairingRedemption = z.object({
  code: z.string().min(1).max(256),
  name: z.string().min(1).max(256),
});
export const PairingResponse = z.object({ url: z.url(), expiresAt: timestamp });
export const DeviceCredential = z.object({
  device: Device,
  token: z.string().regex(/^[0-9a-f]{64}$/),
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
});
export type RemoteAccessStatus = z.infer<typeof RemoteAccessStatus>;
