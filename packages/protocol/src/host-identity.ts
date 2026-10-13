import { z } from "zod";
import { HostId } from "./ids.ts";
const id = z.string().min(1).max(128);

/** The curated machine marks clients draw as icons. */
export const MachineIconKind = z.enum([
  "laptop",
  "desktop",
  "monitor",
  "server",
  "cloud",
  "cpu",
  "terminal",
  "phone",
]);
export type MachineIconKind = z.infer<typeof MachineIconKind>;

/** A person's machine mark, from a curated icon set. Omitted icons use a laptop. */
export const MachineIcon = z.object({
  kind: MachineIconKind,
  color: z.enum(["default", "blue", "green", "purple", "orange"]).optional(),
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
