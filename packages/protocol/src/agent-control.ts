import { PermissionMode } from "./permissions.ts";
import { DeckOwnership } from "./deck-ownership.ts";
import { z } from "zod";
import { AgentId, ThreadId, Timestamp, WorkspaceId, InteractionId } from "./ids.ts";
import { ProviderKind } from "./provider.ts";
import { InteractionResolution } from "./interactions.ts";
import { AcpIdentity } from "./agent-registry.ts";
import { AccountInstanceId } from "./account-ids.ts";
import { AutomationRequest } from "./automations.ts";

const key = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_.-]+$/);
export const AgentLaunchOptions = z.strictObject({
  effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]).optional(),
  serviceTier: z.enum(["default", "priority", "flex"]).optional(),
});
export type AgentLaunchOptions = z.infer<typeof AgentLaunchOptions>;
export const AgentSelection = z.object({
  provider: ProviderKind,
  permissionMode: PermissionMode.optional(),
  ...AcpIdentity.partial().shape,
  model: z.string().min(1).max(256).optional(),
  accountId: AccountInstanceId.optional(),
  options: AgentLaunchOptions.optional(),
});
export type AgentSelection = z.infer<typeof AgentSelection>;
export const DelegationRequest = z.strictObject({
  requestId: key,
  task: z.string().min(1).max(16384),
  role: z.string().min(1).max(1024),
  ...AgentSelection.shape,
  wait: z.boolean().default(false),
  estimatedLoad: z.number().min(0).max(100).default(0),
});
export type DelegationRequest = z.infer<typeof DelegationRequest>;
export const DelegationPolicy = z.strictObject({
  maxConcurrent: z.number().int().min(1).max(64).default(4),
  maxChildren: z.number().int().min(1).max(64).default(64),
  maxDepth: z.number().int().min(1).max(8).default(4),
  durationMs: z.number().int().positive().max(86400000).default(3600000),
  tokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(1000000),
  cost: z.number().positive().finite().default(100),
  coalesceMs: z.number().int().min(0).max(1000).default(50),
});
export type DelegationPolicy = z.infer<typeof DelegationPolicy>;
export const DelegationOutcome = z.strictObject({
  threadId: ThreadId,
  outcome: z.enum(["completed", "failed", "cancelled"]),
  result: z.string().max(4096),
  truncated: z.boolean(),
  before: z.number().int().nonnegative().nullable(),
});
export type DelegationOutcome = z.infer<typeof DelegationOutcome>;
export const DelegationRecord = z.object({
  childId: ThreadId,
  parentId: ThreadId,
  parentAgentId: AgentId,
  rootId: ThreadId,
  requestId: key,
  request: DelegationRequest,
  depth: z.number().int().min(1).max(8),
  createdAt: Timestamp,
  phase: z.enum(["created", "running", "cancelling", "settled"]),
  generation: z.number().int().nonnegative().default(0),
  outcome: DelegationOutcome.optional(),
  resolvedModel: z.string().min(1).max(256).optional(),
  resultDelivery: z.enum(["parent", "owner"]).optional(),
});
export type DelegationRecord = z.infer<typeof DelegationRecord>;
export const ControlThreadInput = z.strictObject({ threadId: ThreadId });
export type ControlThreadInput = z.infer<typeof ControlThreadInput>;
export const AgentControlOperation = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("delegate_task"), ...DelegationRequest.shape }),
  z.strictObject({
    op: z.literal("thread.create"),
    requestId: key,
    title: z.string().min(1).max(256),
    ...AgentSelection.shape,
  }),
  z.strictObject({
    op: z.literal("thread.launch"),
    threadId: ThreadId,
    requestId: key,
    text: z.string().min(1).max(16384),
  }),
  z.strictObject({
    op: z.literal("thread.message"),
    threadId: ThreadId,
    requestId: key,
    text: z.string().min(1).max(16384),
    delivery: z.enum(["queue", "steer"]).default("queue"),
  }),
  z.strictObject({ op: z.literal("thread.wait"), threadId: ThreadId }),
  z.strictObject({
    op: z.literal("thread.read"),
    threadId: ThreadId,
    before: z.number().int().positive().optional(),
    limit: z.number().int().min(1).max(50).default(20),
  }),
  z.strictObject({
    op: z.literal("thread.read_output"),
    threadId: ThreadId,
    streamId: z.string().min(1).max(256),
    offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    limit: z.number().int().min(1).max(16384).default(8192),
  }),
  z.strictObject({
    op: z.literal("thread.search"),
    threadId: ThreadId,
    query: z.string().min(1).max(256),
    cursor: z.string().max(2048).optional(),
    limit: z.number().int().min(1).max(50).default(20),
  }),
  z.strictObject({ op: z.literal("thread.interrupt"), threadId: ThreadId, requestId: key }),
  z.strictObject({
    op: z.literal("thread.fork"),
    threadId: ThreadId,
    requestId: key,
    runId: key.optional(),
  }),
  z.strictObject({ op: z.literal("thread.merge"), threadId: ThreadId, requestId: key }),
  z.strictObject({
    op: z.literal("queue.edit"),
    threadId: ThreadId,
    requestId: key,
    entryId: key,
    text: z.string().min(1).max(16384),
  }),
  z.strictObject({
    op: z.literal("queue.reorder"),
    threadId: ThreadId,
    requestId: key,
    entryIds: z.array(key).min(1).max(64),
  }),
  z.strictObject({
    op: z.literal("question.answer"),
    threadId: ThreadId,
    requestId: key,
    interactionId: InteractionId,
    answer: InteractionResolution.options[1],
  }),
  z.strictObject({
    op: z.literal("thread.rename"),
    threadId: ThreadId,
    title: z.string().min(1).max(256),
  }),
  z.strictObject({ op: z.literal("thread.regenerate_title"), threadId: ThreadId }),
  z.strictObject({ op: z.literal("thread.link_pr"), threadId: ThreadId, url: z.url().max(2048) }),
  z.strictObject({ op: z.literal("thread.settle"), threadId: ThreadId }),
  z.strictObject({
    op: z.literal("thread.snooze"),
    threadId: ThreadId,
    until: Timestamp.nullable(),
  }),
  z.strictObject({ op: z.literal("automation.manage"), request: AutomationRequest }),
  z.strictObject({ op: z.literal("project.read"), workspaceId: WorkspaceId }),
  z.strictObject({
    op: z.literal("project.rename"),
    workspaceId: WorkspaceId,
    name: z.string().min(1).max(256),
  }),
  z.strictObject({
    op: z.literal("thread.handoff"),
    threadId: ThreadId,
    requestId: key,
    branch: z.string().min(1).max(256),
  }),
  z.strictObject({ op: z.literal("preview.list"), threadId: ThreadId }),
  z.strictObject({ op: z.literal("preview.close"), threadId: ThreadId, previewId: key }),
]);
export type AgentControlOperation = z.infer<typeof AgentControlOperation>;
export const AgentControlResult = z.object({
  ok: z.boolean(),
  code: z
    .enum(["unsupported", "forbidden", "not_found", "limit", "not_ready", "invalid", "unavailable"])
    .optional(),
  data: z.unknown().optional(),
});
export type AgentControlResult = z.infer<typeof AgentControlResult>;

export const ThreadPrepareCommand = z.object({
  deck: DeckOwnership.optional(),
  type: z.literal("thread.prepare"),
  handoffFrom: ThreadId.optional(),
  mode: z.enum(["local", "worktree"]).optional(),
  baseBranch: z.string().min(1).max(1024).optional(),
  threadId: ThreadId,
  workspaceId: WorkspaceId,
  title: z.string().min(1).max(256),
  ...AgentSelection.shape,
});

export type ThreadPrepareCommand = z.infer<typeof ThreadPrepareCommand>;
