import { z } from "zod";
import { ThreadId, WorkspaceId } from "./ids.ts";
import { DelegationRequest, AgentControlResult } from "./agent-control.ts";
import { ThreadStatus } from "./thread-status.ts";
import { QueueState } from "./queue.ts";
import { AgentTaskView } from "./agent-orchestration.ts";
import { DelegationOutcome } from "./agent-control.ts";
import { OutsideScope } from "./outside-clients.ts";

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
    }),
  )
  .max(65);
export type CliTree = z.infer<typeof CliTree>;
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
