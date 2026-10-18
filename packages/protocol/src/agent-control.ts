import { ForgePrWorktree } from "./forge-worktree.ts";
import { AccessRequest } from "./permissions.ts";
import { z } from "zod";
import { WorktreeBase } from "./worktree-base.ts";
import { AgentId, ThreadId, Timestamp, WorkspaceId, InteractionId } from "./ids.ts";
import { ProviderKind } from "./provider.ts";
import { InteractionResolution } from "./interactions.ts";
import { AcpIdentity } from "./agent-registry.ts";
import { AccountInstanceId } from "./account-ids.ts";
import { Automation, AutomationRequest } from "./automations.ts";
import { AgentCatalogInput, AgentWorkspace, ThreadListInput } from "./agent-orchestration.ts";
import { WaitInput, WaitMode, WaitTimeoutSeconds } from "./agent-monitor.ts";
import { MachineName } from "./machine-calls.ts";
import { MessageText } from "./message-limits.ts";

const key = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_.-]+$/);
/** A model effort: the catalog's native id or its canonical level ("xhigh" names "extra-high"). */
export const AgentEffort = z.string().min(1).max(64);
export const AgentServiceOptions = z.strictObject({
  serviceTier: z.enum(["default", "priority", "flex"]).optional(),
});
export const AgentLaunchOptions = AgentServiceOptions.extend({ effort: AgentEffort.optional() });
export type AgentLaunchOptions = z.infer<typeof AgentLaunchOptions>;
export const AgentSelection = z.object({
  provider: ProviderKind,
  /** The child's access: its parent's (the default) or a mode no broader than the parent's. */
  access: AccessRequest.optional(),
  ...AcpIdentity.partial().shape,
  model: z.string().min(1).max(256).optional(),
  accountId: AccountInstanceId.optional(),
  /** `inherit` (the default) keeps the parent's effort on the same model, else the model default. */
  effort: z.union([z.literal("inherit"), AgentEffort]).optional(),
  options: AgentServiceOptions.optional(),
});
export type AgentSelection = z.infer<typeof AgentSelection>;
/** The role a delegated child plays, here or on another machine. */
export const DelegationRole = z
  .string()
  .min(1)
  .max(1024)
  .describe(
    "The child's display name. Must be unique among its parent's live children and descriptive of the work (e.g. 'Fix-869-worked-for-toast', never 'Implementer').",
  );
export const DelegationRequest = z.strictObject({
  requestId: key,
  task: MessageText,
  role: DelegationRole,
  ...AgentSelection.shape,
  wait: z.boolean().default(false),
  waitMs: z.number().int().min(1).max(600000).optional(),
  workspace: AgentWorkspace.optional(),
  estimatedLoad: z.number().min(0).max(100).default(0),
  /** Run on another paired machine from `machines`, in one of its projects (ADR 0078). */
  machine: MachineName.optional(),
  project: z.string().min(1).max(256).optional(),
});
export type DelegationRequest = z.infer<typeof DelegationRequest>;
/**
 * One task of a batch; batches wait through `await` rather than per-task flags. An omitted
 * provider is the caller's own provider, or the one whose catalog has the named model; the
 * daemon resolves it before admission.
 */
export const DelegationTask = DelegationRequest.omit({ wait: true, waitMs: true }).extend({
  provider: ProviderKind.optional(),
});
export type DelegationTask = z.infer<typeof DelegationTask>;
/** A single delegation as an operation states it: the provider may still be resolved. */
const SingleDelegation = DelegationRequest.extend({ provider: ProviderKind.optional() });
const single = DelegationRequest.shape;
const singleKeys = Object.keys(single);
/**
 * One child (`task`, `role`, `provider`, ...) or a batch of up to 64 (`tasks`), never both.
 * A batch may await `any` or `all` of its children up to `timeoutSeconds`.
 */
export const DelegateTaskOperation = z
  .strictObject({
    op: z.literal("delegate_task"),
    ...AgentSelection.partial().shape,
    requestId: single.requestId.optional(),
    task: single.task.optional(),
    role: single.role.optional(),
    wait: z.boolean().optional(),
    waitMs: z.number().int().min(1).max(600000).optional(),
    workspace: AgentWorkspace.optional(),
    estimatedLoad: z.number().min(0).max(100).optional(),
    machine: MachineName.optional(),
    project: z.string().min(1).max(256).optional(),
    tasks: z.array(DelegationTask).min(1).max(64).optional(),
    await: z.enum(["none", ...WaitMode.options]).optional(),
    timeoutSeconds: WaitTimeoutSeconds.optional(),
  })
  .superRefine((input, context) => {
    if (input.tasks) {
      for (const field of singleKeys)
        if (input[field as keyof typeof input] !== undefined)
          context.addIssue({
            code: "custom",
            path: [field],
            message: "Put each task's fields inside tasks.",
          });
      return;
    }
    for (const field of ["await", "timeoutSeconds"] as const)
      if (input[field] !== undefined)
        context.addIssue({ code: "custom", path: [field], message: "Only a tasks batch awaits." });
    const { op: _op, tasks: _tasks, await: _await, timeoutSeconds: _timeout, ...rest } = input;
    const parsed = SingleDelegation.safeParse(rest);
    if (!parsed.success)
      for (const issue of parsed.error.issues)
        context.addIssue({ code: "custom", message: issue.message, path: issue.path });
  })
  .meta({
    "x-ace-constraint":
      "Either one task (requestId, task, role, provider) or tasks: [{ requestId, task, role, provider }, ...].",
    examples: [
      {
        op: "delegate_task",
        requestId: "review-on-studio",
        task: "Review the 0.9 build and list failing benchmarks",
        role: "Review-0.9-build",
        provider: "claude",
        machine: "studio",
        project: "relay",
        access: "read-only",
        effort: "high",
      },
    ],
  });
export type DelegateTaskOperation = z.infer<typeof DelegateTaskOperation>;
export const DelegationPolicy = z.strictObject({
  /** Children one parent runs at once. Further children wait queued, never refused. */
  maxConcurrent: z.number().int().min(1).max(64).default(4),
  maxDepth: z.number().int().min(1).max(8).default(8),
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
  /** The child model's native effort id the request resolved to; absent keeps the model default. */
  resolvedEffort: z.string().min(1).max(256).optional(),
  resultDelivery: z.enum(["parent", "owner"]).optional(),
});
export type DelegationRecord = z.infer<typeof DelegationRecord>;
export const ControlThreadInput = z.strictObject({ threadId: ThreadId });
export type ControlThreadInput = z.infer<typeof ControlThreadInput>;
export const ThreadStartOperation = z.strictObject({
  op: z.literal("thread.start"),
  requestId: key,
  title: z.string().min(1).max(256),
  text: MessageText,
  workspace: AgentWorkspace,
  /** Another local project, by id, name or folder path. Omitted: the caller's own project. */
  project: z.string().min(1).max(4096).optional(),
  ...AgentSelection.shape,
  /** Omitted: the caller's own provider, resolved by the daemon before the thread starts. */
  provider: ProviderKind.optional(),
});
export type ThreadStartOperation = z.infer<typeof ThreadStartOperation>;
export const AgentConversationRecord = z.object({
  threadId: ThreadId,
  ownerThreadId: ThreadId,
  ownerAgentId: AgentId,
  rootId: ThreadId,
  createdAt: Timestamp,
  request: ThreadStartOperation,
});
export type AgentConversationRecord = z.infer<typeof AgentConversationRecord>;
/**
 * An agent's automation definition: the daemon supplies the caller's project, and agent jobs
 * never use worktrees or jitter, so those may be omitted. Omitted provider: the caller's own.
 */
export const AgentAutomation = Automation.extend({
  workspace: Automation.shape.workspace.optional(),
  provider: ProviderKind.optional(),
  worktree: Automation.shape.worktree.optional(),
  jitterMs: Automation.shape.jitterMs.optional(),
  enabled: z.boolean().default(true),
  missedRun: Automation.shape.missedRun.default("skip"),
  concurrency: Automation.shape.concurrency.default(1),
});
export type AgentAutomation = z.infer<typeof AgentAutomation>;
export const AgentAutomationRequest = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("automation.put"),
    requestId: AutomationRequest.options[0].shape.requestId,
    automation: AgentAutomation,
  }),
  AutomationRequest.options[1],
  AutomationRequest.options[2],
  AutomationRequest.options[3],
  AutomationRequest.options[4],
]);
export type AgentAutomationRequest = z.infer<typeof AgentAutomationRequest>;
export const AgentControlOperation = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("threads.list"), ...ThreadListInput.shape }),
  ThreadStartOperation,
  z.strictObject({
    op: z.literal("thread.configure"),
    threadId: ThreadId,
    requestId: key,
    model: z.string().min(1).max(256),
    options: AgentLaunchOptions.optional(),
  }),
  z.strictObject({ op: z.literal("agents.catalog"), ...AgentCatalogInput.shape }),
  z.strictObject({ op: z.literal("agent.status"), threadId: ThreadId }),
  z.strictObject({ op: z.literal("agents.status") }),
  z.strictObject({ op: z.literal("machines") }),
  z.strictObject({ op: z.literal("agent.result"), threadId: ThreadId }),
  z.strictObject({ op: z.literal("agent.cancel"), threadId: ThreadId, requestId: key }),
  z.strictObject({
    op: z.literal("agent.message"),
    threadId: ThreadId,
    requestId: key,
    text: MessageText,
    delivery: z.enum(["queue", "steer"]).default("queue"),
  }),
  DelegateTaskOperation,
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
    text: MessageText,
  }),
  z.strictObject({
    op: z.literal("thread.message"),
    threadId: ThreadId,
    requestId: key,
    text: MessageText,
    delivery: z.enum(["queue", "steer", "restart"]).default("queue"),
  }),
  z.strictObject({ op: z.literal("wait"), ...WaitInput }),
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
    text: MessageText,
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
    onlyIfProvisional: z.boolean().optional(),
  }),
  z.strictObject({ op: z.literal("thread.regenerate_title"), threadId: ThreadId }),
  z
    .strictObject({
      op: z.literal("thread.link_pr"),
      url: z.url().max(2048).optional(),
      number: z.number().int().positive().optional(),
      repo: z.string().min(1).max(512).optional(),
    })
    .refine((input) => (input.url === undefined) !== (input.number === undefined), {
      message: "Provide a pull request URL or number.",
    })
    .meta({
      "x-ace-constraint": "Exactly one of url or number is required.",
      oneOf: [{ required: ["url"] }, { required: ["number"] }],
    }),
  z
    .strictObject({
      op: z.literal("thread.unlink_pr"),
      url: z.url().max(2048).optional(),
      number: z.number().int().positive().optional(),
      all: z.literal(true).optional(),
    })
    .refine(
      (input) =>
        [input.url, input.number, input.all].filter((value) => value !== undefined).length === 1,
      {
        message: "Provide a pull request URL, number, or all: true.",
      },
    )
    .meta({
      "x-ace-constraint": "Exactly one of url, number, or all: true is required.",
      oneOf: [{ required: ["url"] }, { required: ["number"] }, { required: ["all"] }],
    }),
  z.strictObject({ op: z.literal("thread.list_prs") }),
  z.strictObject({ op: z.literal("thread.settle"), threadId: ThreadId }),
  z.strictObject({ op: z.literal("thread.unsettle"), threadId: ThreadId }),
  /** This machine's projects, matched by name or path; empty query lists recent ones first. */
  z.strictObject({
    op: z.literal("projects.list"),
    query: z.string().max(256).default(""),
    limit: z.number().int().min(1).max(50).default(20),
  }),
  z.strictObject({
    op: z.literal("thread.snooze"),
    threadId: ThreadId,
    until: Timestamp.nullable(),
  }),
  z.strictObject({ op: z.literal("automation.manage"), request: AgentAutomationRequest }),
  /** Omitted workspaceId: the caller's own project. */
  z.strictObject({ op: z.literal("project.read"), workspaceId: WorkspaceId.optional() }),
  z.strictObject({
    op: z.literal("project.rename"),
    workspaceId: WorkspaceId.optional(),
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
  /** On failure: what to do next, authored by ace. */
  hint: z.string().max(512).optional(),
  data: z.unknown().optional(),
});
export type AgentControlResult = z.infer<typeof AgentControlResult>;

export const ThreadPrepareCommand = z.object({
  type: z.literal("thread.prepare"),
  pullRequest: ForgePrWorktree.optional(),
  handoffFrom: ThreadId.optional(),
  mode: z.enum(["local", "worktree"]).optional(),
  baseBranch: z.string().min(1).max(1024).optional(),
  /** Where a worktree starts, local or on a remote; wins over `baseBranch`. */
  base: WorktreeBase.optional(),
  threadId: ThreadId,
  workspaceId: WorkspaceId,
  title: z.string().min(1).max(256),
  ...AgentSelection.shape,
  /** The resolved native effort and service tier the prepared thread starts with. */
  options: AgentLaunchOptions.optional(),
});

export type ThreadPrepareCommand = z.infer<typeof ThreadPrepareCommand>;
