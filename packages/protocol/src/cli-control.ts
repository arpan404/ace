import { z } from "zod";
import { ThreadId } from "./ids.ts";
import { DelegationRequest, AgentControlResult } from "./agent-control.ts";
import { ThreadStatus } from "./thread-status.ts";

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
  .array(z.object({ threadId: ThreadId, status: ThreadStatus, pending: z.boolean() }))
  .max(65);
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
