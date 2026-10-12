import { z } from "zod";
import { ThreadId } from "./ids.ts";
import { DelegationRequest, AgentControlResult } from "./agent-control.ts";
import { ThreadStatus } from "./thread-status.ts";
import { QueueState } from "./queue.ts";
import { AgentTaskView } from "./agent-orchestration.ts";
import { DelegationOutcome } from "./agent-control.ts";

export const CliOperation = z.discriminatedUnion("op", [
  z.object({ op: z.literal("thread.tree"), threadId: ThreadId }),
  z.object({ op: z.literal("task.spawn"), parentId: ThreadId, request: DelegationRequest }),
  z.object({ op: z.literal("task.status"), threadId: ThreadId }),
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
    }),
  )
  .max(65);
export type CliTree = z.infer<typeof CliTree>;
export const CliTaskStatus = AgentTaskView.extend({
  state: AgentTaskView.shape.state.or(z.literal("unresponsive")),
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
