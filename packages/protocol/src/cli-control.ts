import { z } from "zod";
import { ThreadId, WorkspaceId } from "./ids.ts";
import { DelegationRequest, AgentControlResult } from "./agent-control.ts";
import { ThreadStatus } from "./thread-status.ts";
import { QueueState } from "./queue.ts";
import { AgentTaskView } from "./agent-orchestration.ts";
import { DelegationOutcome } from "./agent-control.ts";
import { OutsideScope } from "./outside-clients.ts";
import { Interaction } from "./interactions.ts";
import { ProviderKind } from "./provider-data.ts";

/** The `ace sim` verbs; each is the sim_* MCP tool of the same name. */
export const CliSimVerb = z.enum(["list", "start", "stop", "ui", "act", "screenshot", "logs"]);
export type CliSimVerb = z.infer<typeof CliSimVerb>;
export const CliOperation = z.discriminatedUnion("op", [
  z.object({ op: z.literal("capabilities") }),
  z.object({
    op: z.literal("process.kill_all"),
    threadId: ThreadId.optional(),
    provider: z.string().max(128).optional(),
    project: WorkspaceId.optional(),
    key: z.string().regex(/^[a-zA-Z0-9_.-]{1,128}$/),
  }),
  /**
   * A grant for an outside MCP client that takes a pasted token (ADR 0122). `scope` is the old
   * shorthand; `allow` names scopes exactly. Null `ttlMs`: until revoked.
   */
  z.object({
    op: z.literal("mcp.enroll"),
    scope: z.enum(["read", "operate"]).optional(),
    allow: z.array(OutsideScope).min(1).max(OutsideScope.options.length).optional(),
    ttlMs: z
      .number()
      .int()
      .positive()
      .max(366 * 86_400_000)
      .nullable(),
    projects: z.array(WorkspaceId).min(1).max(256).optional(),
    name: z.string().min(1).max(256).optional(),
  }),
  z.object({ op: z.literal("mcp.list") }),
  z.object({ op: z.literal("mcp.revoke"), id: z.string().min(1).max(128) }),
  z.object({ op: z.literal("thread.tree"), threadId: ThreadId }),
  /**
   * Every open request (approval, question, plan review, elicitation…) across the threads the
   * caller can read, oldest first; with `threadId`, that thread's and its delegated tree's.
   */
  z.object({
    op: z.literal("request.list"),
    threadId: ThreadId.optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  z.object({ op: z.literal("task.spawn"), parentId: ThreadId, request: DelegationRequest }),
  z.object({ op: z.literal("task.status"), threadId: ThreadId }),
  /** `ace sim`: one sim_* tool call, for the root agent of `threadId`. Args as the tool takes them. */
  z.object({
    op: z.literal("sim"),
    threadId: ThreadId,
    verb: CliSimVerb,
    args: z.record(z.string().max(64), z.unknown()),
  }),
  z.object({
    op: z.literal("task.cancel"),
    threadId: ThreadId,
    key: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z0-9_.-]+$/),
  }),
]);
export type CliOperation = z.infer<typeof CliOperation>;
export const CliTree = z
  .array(
    z.object({
      threadId: ThreadId,
      status: ThreadStatus,
      pending: z.boolean(),
      queue: QueueState.extend({ uncertain: z.boolean() }),
      attention: z.string().optional(),
      cancelled: z.boolean(),
      /** The thread that delegated this one; absent for the tree's root. */
      parentId: ThreadId.optional(),
      title: z.string().max(256).optional(),
    }),
  )
  .max(65);
export type CliTree = z.infer<typeof CliTree>;
/** One open request, with the thread it waits in (`request.list`). */
export const CliOpenRequest = z.object({
  threadId: ThreadId,
  threadTitle: z.string().max(256),
  workspaceId: WorkspaceId,
  provider: ProviderKind,
  interaction: Interaction,
});
export type CliOpenRequest = z.infer<typeof CliOpenRequest>;
export const CliRequestList = z.object({
  requests: z.array(CliOpenRequest).max(200),
  /** More were open than `limit` allowed. */
  truncated: z.boolean(),
});
export type CliRequestList = z.infer<typeof CliRequestList>;
export const CliTaskStatus = AgentTaskView.extend({
  // A union, not `.or()`: browser workers load protocol schemas and leave `.or()` out.
  state: z.union([AgentTaskView.shape.state, z.literal("unresponsive")]),
  status: ThreadStatus,
  outcome: DelegationOutcome.optional(),
});
export const CliRequest = z.object({
  type: z.literal("cli.request"),
  requestId: z.string().min(1),
  operation: CliOperation,
});
export const CliResult = z.object({
  type: z.literal("cli.result"),
  requestId: z.string().min(1),
  result: AgentControlResult,
});
