import { z } from "zod";
import { HostId, Timestamp } from "./ids.ts";
const id = z.string().min(1).max(128);
/** Deprecated proposed host-owned directory. No daemon implements this inventory. */
export const Machine = z.object({
  hostId: HostId,
  name: z.string().min(1).max(256),
  status: z.enum(["online", "offline", "unknown"]),
  observedAt: Timestamp.optional(),
});
export type Machine = z.infer<typeof Machine>;
export const MachinesRequest = z.object({
  type: z.literal("machines.request"),
  requestId: id,
  operation: z.discriminatedUnion("op", [
    z.object({
      op: z.literal("list"),
      after: HostId.optional(),
      limit: z.number().int().min(1).max(100).default(50),
    }),
    z.object({ op: z.literal("status"), hostId: HostId }),
  ]),
});
export type MachinesRequest = z.infer<typeof MachinesRequest>;
export const MachinesResult = z.object({
  type: z.literal("machines.result"),
  requestId: id,
  result: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("list"),
      machines: z.array(Machine).max(100),
      next: HostId.optional(),
    }),
    z.object({ kind: z.literal("status"), machine: Machine.nullable() }),
    z.object({
      kind: z.literal("unavailable"),
      reason: z.enum(["directory_not_configured", "forbidden"]),
    }),
  ]),
});
export type MachinesResult = z.infer<typeof MachinesResult>;

/** Authenticated identity of this daemon, never an inventory of other hosts. */
export const HostIdentity = z.object({
  hostId: HostId,
  displayName: z.string().min(1).max(256),
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
