import { z } from "zod";
import { AgentId, HostId, InteractionId, ThreadId, WorkspaceId } from "./ids.ts";
import { MachineGrants } from "./machine-grants.ts";
import { InteractionRequest, InteractionResolution } from "./interactions.ts";
import { ProviderKind } from "./provider.ts";
import { ThreadStatus } from "./thread-status.ts";
import { WatchedThread } from "./agent-monitor.ts";
import { MessageText } from "./message-limits.ts";
import { MessageArrival } from "./message-arrival.ts";

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
/** Tool groups a machine offers to agents elsewhere: one per capability it grants (ADR 0105). */
export const MachineToolGroup = z.enum(["agents", "browser", "devices", "screen", "commands"]);
export type MachineToolGroup = z.infer<typeof MachineToolGroup>;
/** Groups as a target lists them: ones this build doesn't know yet are left out, not fatal. */
const OfferedGroups = z
  .array(z.string().max(64))
  .max(16)
  .transform((names) =>
    names.flatMap((name) => {
      const group = MachineToolGroup.safeParse(name);
      return group.success ? [group.data] : [];
    }),
  );
export const MachineProject = z.object({ workspaceId: WorkspaceId, name: z.string().max(256) });
export type MachineProject = z.infer<typeof MachineProject>;

/** What a target says about itself to one paired device. */
export const MachineDescription = z.object({
  hostId: HostId,
  name: z.string().min(1).max(256),
  /** The lower of the pairing scope and the target's agent access. */
  access: z.enum(["read", "operate"]),
  /** Each capability's effective level for this device (ADR 0105). */
  grants: MachineGrants.optional(),
  projects: z.array(MachineProject).max(32),
  tools: OfferedGroups,
  providers: z.array(ProviderKind).max(16),
  /** This device may move projects and threads here (ADR 0101). */
  transfers: z.boolean().optional(),
});
export type MachineDescription = z.infer<typeof MachineDescription>;

/** One entry of `machines`. Offline machines are listed only once seen opted in. */
export const MachineSummary = z.object({
  machine: MachineName,
  name: z.string().min(1).max(256),
  status: z.enum(["online", "offline"]),
  access: z.enum(["read", "operate"]).optional(),
  /** Each capability's effective level for this machine's agents there (ADR 0105). */
  grants: MachineGrants.optional(),
  projects: z.array(MachineProject).max(32).optional(),
  tools: z.array(MachineToolGroup).max(8).optional(),
  providers: z.array(ProviderKind).max(16).optional(),
  /** Agents here may `transfer` projects and threads to it (ADR 0101). */
  transfers: z.boolean().optional(),
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
  /** The calling agent, so each remote agent holds its own leases there (ADR 0105). */
  agentId: AgentId.optional(),
  /** The calling thread's ceiling: a read-only thread never acts there. Absent is operate. */
  ceiling: z.enum(["read", "operate"]).optional(),
});
export type MachineCallOrigin = z.infer<typeof MachineCallOrigin>;

const requestKey = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_.-]+$/);
const MachineMessageFields = {
  requestId: requestKey,
  text: MessageText,
  delivery: z.enum(["queue", "steer", "restart"]),
};
export const MachineMessage = z.strictObject(MachineMessageFields);
export type MachineMessage = z.infer<typeof MachineMessage>;
export const MachineCall = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("describe") }),
  z.strictObject({
    op: z.literal("delegate"),
    requestId: requestKey,
    /** A project id or name on the target; optional when it has exactly one. */
    project: z.string().min(1).max(256).optional(),
    task: MessageText,
    role: z.string().min(1).max(1024),
    provider: ProviderKind,
    model: z.string().min(1).max(256).optional(),
  }),
  z.strictObject({ op: z.literal("status"), threadIds: z.array(ThreadId).min(1).max(16) }),
  z.strictObject({ op: z.literal("cancel"), threadId: ThreadId }),
  /** Follow-up work from the parent agent for a child it delegated here. */
  z.strictObject({ op: z.literal("message"), threadId: ThreadId, ...MachineMessageFields }),
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
    tool: z.string().regex(/^browser_[a-z_]{1,64}$/),
    args: z.record(z.string(), z.unknown()),
  }),
  /** A simulator or emulator tool (`sim_*`) on that machine's devices (ADR 0105). */
  z.strictObject({
    op: z.literal("devices"),
    tool: z.string().regex(/^sim_[a-z_]{1,64}$/),
    args: z.record(z.string(), z.unknown()),
  }),
  /** A computer-use tool (`screen_*`) on that machine's screen (ADR 0105). */
  z.strictObject({
    op: z.literal("screen"),
    tool: z.string().regex(/^screen_[a-z_]{1,64}$/),
    args: z.record(z.string(), z.unknown()),
  }),
  /** A command tool, run in one of that machine's projects (ADR 0105). */
  z.strictObject({
    op: z.literal("commands"),
    tool: z.string().regex(/^command_[a-z_]{1,64}$/),
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
  /** A parent's message to it that failed or was kept back after it was accepted. */
  notice: z
    .object({
      text: z.string().max(400),
      /** The message it is about, and what happened to it: one notice each. */
      commandId: z.string().min(1).max(128),
      code: z.string().min(1).max(64),
    })
    .optional(),
});
export type MachineThreadView = z.infer<typeof MachineThreadView>;
export const MachineStatusResult = z.object({ threads: z.array(MachineThreadView).max(16) });
export const MachineDelegateResult = z.object({
  threadId: ThreadId,
  title: z.string().max(256),
  /** It waits there for a free slot and starts on its own; it was not refused. */
  queued: z.boolean().optional(),
});
export const MachineSessionResult = z.object({ threadId: ThreadId });
export const MachineMessageResult = z.object({ arrival: MessageArrival });
/** A tool's MCP result (browser, devices, screen, commands), as the target's registry made it. */
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
    /** A transfer cancel that came after the import's cutoff (ADR 0101). */
    "too_late",
    /** Allowed, but this machine doesn't serve that capability yet (ADR 0105). */
    "not_supported",
  ]),
  message: z.string().max(512).optional(),
  /**
   * The target's answer for the request id is recorded: every copy of that request, a retry or
   * one still on its way, gets this same answer and none runs anew. Without it a refusal answers
   * only this attempt (an access check, a machine still starting).
   */
  final: z.boolean().optional(),
});
export type MachineRefusal = z.infer<typeof MachineRefusal>;
