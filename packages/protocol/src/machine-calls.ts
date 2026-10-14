import { z } from "zod";
import { HostId, InteractionId, ThreadId, WorkspaceId } from "./ids.ts";
import { InteractionRequest, InteractionResolution } from "./interactions.ts";
import { ProviderKind } from "./provider.ts";
import { ThreadStatus } from "./thread-status.ts";
import { WatchedThread } from "./agent-monitor.ts";

/**
 * Agent calls between paired machines (ADR 0078). The calling daemon forwards over the target's
 * TLS listener with its own paired-device token; the target applies its own consent and access.
 * Nothing here carries a credential: tokens stay in the caller's remote profile store.
 */

/** A remote profile name from `ace remote add`: what agents pass as `machine`. */
export const MachineName = z.string().regex(/^[a-zA-Z0-9_.-]{1,64}$/);
export type MachineName = z.infer<typeof MachineName>;
/** The target's opt-in for agents on other machines. `off` refuses every agent call. */
export const MachineAgentAccess = z.enum(["off", "read", "operate"]);
export type MachineAgentAccess = z.infer<typeof MachineAgentAccess>;
/** Tool groups a machine offers to agents elsewhere. */
export const MachineToolGroup = z.enum(["agents", "browser"]);
export type MachineToolGroup = z.infer<typeof MachineToolGroup>;
export const MachineProject = z.object({ workspaceId: WorkspaceId, name: z.string().max(256) });
export type MachineProject = z.infer<typeof MachineProject>;

/** What a target says about itself to one paired device. */
export const MachineDescription = z.object({
  hostId: HostId,
  name: z.string().min(1).max(256),
  /** The lower of the pairing scope and the target's agent access. */
  access: z.enum(["read", "operate"]),
  projects: z.array(MachineProject).max(32),
  tools: z.array(MachineToolGroup).max(8),
  providers: z.array(ProviderKind).max(16),
});
export type MachineDescription = z.infer<typeof MachineDescription>;

/** One entry of `ace_machines`. Offline machines are listed only once seen opted in. */
export const MachineSummary = z.object({
  machine: MachineName,
  name: z.string().min(1).max(256),
  status: z.enum(["online", "offline"]),
  access: z.enum(["read", "operate"]).optional(),
  projects: z.array(MachineProject).max(32).optional(),
  tools: z.array(MachineToolGroup).max(8).optional(),
  providers: z.array(ProviderKind).max(16).optional(),
  /** What to do next when the machine can't be used right now. */
  next: z.string().max(256).optional(),
});
export type MachineSummary = z.infer<typeof MachineSummary>;

/** Who is calling, for attribution and logs on the target. */
export const MachineCallOrigin = z.object({
  hostId: HostId,
  hostName: z.string().min(1).max(256),
  threadId: ThreadId,
  threadTitle: z.string().max(256),
});
export type MachineCallOrigin = z.infer<typeof MachineCallOrigin>;

const requestKey = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_.-]+$/);
export const MachineCall = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("describe") }),
  z.strictObject({
    op: z.literal("delegate"),
    requestId: requestKey,
    /** A project id or name on the target; optional when it has exactly one. */
    project: z.string().min(1).max(256).optional(),
    task: z.string().min(1).max(16384),
    role: z.string().min(1).max(1024),
    provider: ProviderKind,
    model: z.string().min(1).max(256).optional(),
  }),
  z.strictObject({ op: z.literal("status"), threadIds: z.array(ThreadId).min(1).max(16) }),
  z.strictObject({ op: z.literal("cancel"), threadId: ThreadId }),
  /** The person's answer, forwarded from the device they are looking at. Never an agent's. */
  z.strictObject({
    op: z.literal("respond"),
    threadId: ThreadId,
    interactionId: InteractionId,
    resolution: InteractionResolution,
  }),
  /** The target thread that owns this caller's browser and its consent requests. */
  z.strictObject({ op: z.literal("browser.session") }),
  z.strictObject({
    op: z.literal("browser"),
    tool: z.string().regex(/^ace_browser_[a-z_]{1,64}$/),
    args: z.record(z.string(), z.unknown()),
  }),
]);
export type MachineCall = z.infer<typeof MachineCall>;
export const MachineCallRequest = z.object({ origin: MachineCallOrigin, call: MachineCall });
export type MachineCallRequest = z.infer<typeof MachineCallRequest>;

/** A request on the target that waits for the person, with what is needed to mirror it. */
export const MachinePendingRequest = z.object({
  threadId: ThreadId,
  interactionId: InteractionId,
  request: InteractionRequest,
});
export type MachinePendingRequest = z.infer<typeof MachinePendingRequest>;
export const MachineThreadView = WatchedThread.extend({
  status: ThreadStatus,
  requests: z.array(MachinePendingRequest).max(8),
});
export type MachineThreadView = z.infer<typeof MachineThreadView>;
export const MachineStatusResult = z.object({ threads: z.array(MachineThreadView).max(16) });
export const MachineDelegateResult = z.object({ threadId: ThreadId, title: z.string().max(256) });
export const MachineSessionResult = z.object({ threadId: ThreadId });
/** A browser tool's MCP result, as the target's own registry produced it. */
export const MachineToolResult = z.object({
  isError: z.boolean().optional(),
  content: z
    .array(
      z.union([
        z.object({ type: z.literal("text"), text: z.string() }),
        z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string().max(64) }),
      ]),
    )
    .max(16),
});
export type MachineToolResult = z.infer<typeof MachineToolResult>;
/** Refusals a target returns; never free text from elsewhere. */
export const MachineRefusal = z.object({
  error: z.enum([
    "machine_opted_out",
    "machine_forbidden",
    "unauthorized",
    "not_found",
    "invalid",
    "unavailable",
  ]),
  message: z.string().max(512).optional(),
});
export type MachineRefusal = z.infer<typeof MachineRefusal>;
