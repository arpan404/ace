import { z } from "zod";
import { DeviceId } from "./ids.ts";

export const DeviceScope = z.enum(["read", "operate", "admin", "desktop"]);
export type DeviceScope = z.infer<typeof DeviceScope>;
const timestamp = z.number().int().nonnegative();
export const Device = z.object({
  id: DeviceId,
  name: z.string().min(1).max(256),
  scopes: z.array(DeviceScope).min(1).max(4),
  createdAt: timestamp,
  lastSeenAt: timestamp,
  revokedAt: timestamp.nullable(),
});
export type Device = z.infer<typeof Device>;
export const PairingRequest = z.object({
  scopes: z
    .array(DeviceScope.exclude(["desktop"]))
    .min(1)
    .max(3)
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
