import { z } from "zod";
import { HostId } from "./ids.ts";
const id = z.string().min(1).max(128);

/** A person's machine mark. Omitted icons from older hosts use a laptop. */
export const MachineIcon = z.object({
  kind: z.enum(["laptop", "desktop", "server", "cloud", "phone", "emoji"]),
  color: z.enum(["default", "blue", "green", "purple", "orange"]).optional(),
  emoji: z.string().min(1).max(16).optional(),
});
export type MachineIcon = z.infer<typeof MachineIcon>;

/** Authenticated identity of this daemon, never an inventory of other hosts. */
export const HostIdentity = z.object({
  hostId: HostId,
  displayName: z.string().min(1).max(256),
  icon: MachineIcon.optional(),
  /** Legacy thread metadata used this OS hostname instead of the stable host ID. */
  hostname: z.string().max(256).optional(),
  version: z.string().min(1).max(128),
});
export type HostIdentity = z.infer<typeof HostIdentity>;
export const HostIdentityRequest = z.object({
  type: z.literal("host.identity"),
  requestId: id,
});
export const HostIdentityResult = z.object({
  type: z.literal("host.identity.result"),
  requestId: id,
  identity: HostIdentity,
});
