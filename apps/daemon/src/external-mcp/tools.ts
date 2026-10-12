import { z } from "zod";
import {
  DelegationRequest,
  ThreadListCursor,
  ThreadId,
  WorkspaceId,
  ProviderKind,
} from "@ace/protocol";
import { ToolRegistry, nodeScheduler } from "@ace/mcp-server";
import type { Enrollments, Enrollment } from "./enrollments.ts";
import type { ServiceContext } from "../services/types.ts";
import { cliControl } from "../services/cli-control.ts";
const output = z.object({
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
});
export function externalTools(
  context: ServiceContext,
  enrollments: Enrollments,
  admits: () => boolean,
) {
  const registry = new ToolRegistry({ scheduler: nodeScheduler, maxTools: 16 });
  const thread = (entry: Enrollment, id: string) => {
    const value = context.store.getThread(ThreadId.parse(id));
    if (!value || (entry.project && value.workspaceId !== entry.project))
      throw new Error("Outside enrolled project");
    return value;
  };
  registry.register({
    name: "ace_threads_list",
    description: "List threads within the enrolled project. Results are bounded.",
    input: z.object({
      before: ThreadListCursor.optional(),
      limit: z.number().int().min(1).max(100).default(20),
    }),
    output,
    capability: null,
    timeoutMs: 15000,
    async run(input, { caller, signal }) {
      signal.throwIfAborted();
      const entry = enrollments.caller(caller);
      const page = context.store.sidebarPage(
        { limit: input.limit, ...(entry.project ? { project: entry.project } : {}) },
        input.before,
      );
      return { ok: true, data: page };
    },
  });
  registry.register({
    name: "ace_thread_read",
    description: "Read a bounded transcript page from the enrolled project.",
    input: z.object({
      threadId: ThreadId,
      before: z.number().int().positive().optional(),
      limit: z.number().int().min(1).max(100).default(20),
    }),
    output,
    capability: null,
    timeoutMs: 15000,
    async run(input, { caller, signal }) {
      signal.throwIfAborted();
      const value = thread(enrollments.caller(caller), input.threadId);
      return {
        ok: true,
        data: {
          thread: value,
          ...context.store.readItemPage(
            value.id,
            input.before ?? context.store.headSeq() + 1,
            input.limit,
            48 * 1024,
          ),
        },
      };
    },
  });
  registry.register({
    name: "ace_thread_status",
    description:
      "Read canonical whole-tree state. Human interactions and active descendants prevent completion.",
    input: z.object({ threadId: ThreadId }),
    output,
    capability: null,
    timeoutMs: 15000,
    async run(input, { caller, signal }) {
      thread(enrollments.caller(caller), input.threadId);
      const response = await cliControl(context)(
        { op: "thread.tree", threadId: input.threadId },
        signal,
      );
      return { ok: response.ok, data: response.data, error: response.code };
    },
  });
  registry.register({
    name: "ace_thread_run",
    description:
      "Start independent work using the user's installed CLI in a registered project. Retry the same idempotency key.",
    input: z.object({
      project: WorkspaceId,
      provider: ProviderKind,
      text: z.string().min(1).max(16384),
      model: z.string().max(256).optional(),
      idempotencyKey: z.string().regex(/^[a-zA-Z0-9_.-]{1,128}$/),
    }),
    output,
    capability: "thread_control",
    timeoutMs: 15000,
    async run(input, { caller, signal }) {
      const entry = enrollments.caller(caller);
      if (
        !admits() ||
        entry.scope !== "operate" ||
        (entry.project && entry.project !== input.project) ||
        !context.store.getWorkspace(input.project)
      )
        return { ok: false, error: "forbidden" };
      signal.throwIfAborted();
      const engine = context.services.engine;
      if (!engine) return { ok: false, error: "unavailable" };
      const receipt = context.services.agentControl?.delegations.command(
        `external:${entry.id}:${input.idempotencyKey}`,
        {
          type: "thread.create",
          workspaceId: input.project,
          provider: input.provider,
          model: input.model,
          input: [{ type: "text", text: input.text }],
        },
      );
      return { ok: receipt?.ok ?? false, data: receipt, error: receipt?.error };
    },
  });
  registry.register({
    name: "ace_thread_send",
    description:
      "Send or steer a thread in the enrolled project. This grants no permission approval authority.",
    input: z.object({
      threadId: ThreadId,
      text: z.string().min(1).max(16384),
      delivery: z.enum(["queue", "steer"]).default("queue"),
      idempotencyKey: z.string().regex(/^[a-zA-Z0-9_.-]{1,128}$/),
    }),
    output,
    capability: "thread_control",
    timeoutMs: 15000,
    async run(input, { caller, signal }) {
      const entry = enrollments.caller(caller);
      thread(entry, input.threadId);
      if (!admits() || entry.scope !== "operate" || !context.services.engine)
        return { ok: false, error: "forbidden" };
      signal.throwIfAborted();
      const receipt = context.services.agentControl?.delegations.command(
        `external:${entry.id}:${input.idempotencyKey}`,
        {
          type: "thread.send",
          threadId: input.threadId,
          input: [{ type: "text", text: input.text }],
          delivery: input.delivery,
        },
      );
      return {
        ok: receipt?.ok ?? false,
        data: receipt,
        error: receipt?.error ?? (receipt ? undefined : "unavailable"),
      };
    },
  });
  registry.register({
    name: "ace_task_control",
    description:
      "Spawn, inspect or cancel a delegated task within the enrolled project. Cannot approve permissions.",
    input: z.object({
      operation: z.union([
        z.object({ op: z.literal("task.spawn"), parentId: ThreadId, request: DelegationRequest }),
        z.object({ op: z.literal("task.status"), threadId: ThreadId }),
        z.object({
          op: z.literal("task.cancel"),
          threadId: ThreadId,
          key: z.string().regex(/^[a-zA-Z0-9_.-]{1,128}$/),
        }),
      ]),
    }),
    output,
    capability: "agents",
    timeoutMs: 15000,
    async run(input, { caller, signal }) {
      const entry = enrollments.caller(caller);
      if (!admits() || entry.scope !== "operate") return { ok: false, error: "forbidden" };
      thread(
        entry,
        input.operation.op === "task.spawn" ? input.operation.parentId : input.operation.threadId,
      );
      const response = await cliControl(context)(input.operation, signal);
      return { ok: response.ok, data: response.data, error: response.code };
    },
  });
  return registry;
}
