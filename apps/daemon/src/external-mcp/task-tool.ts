import { realpath } from "node:fs/promises";
import { z } from "zod";
import {
  AgentId,
  DelegationRequest,
  ThreadId,
  type McpAttribution,
  type OutsideGrant,
  type Thread,
} from "@ace/protocol";
import type { ToolRegistry } from "@ace/mcp-server";
import type { ServiceContext } from "../services/types.ts";
import { cliControl } from "../services/cli-control.ts";
import type { GrantStore } from "./grants.ts";
import { grantKey, spawnAllowed } from "./spawn-limits.ts";

const idempotencyKey = z.string().regex(/^[a-zA-Z0-9_.-]{1,128}$/);
const output = z.object({
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
});
const TaskInput = z.object({
  operation: z.union([
    z.object({ op: z.literal("task.spawn"), parentId: ThreadId, request: DelegationRequest }),
    z.object({ op: z.literal("task.status"), threadId: ThreadId }),
    z.object({ op: z.literal("task.cancel"), threadId: ThreadId, key: idempotencyKey }),
  ]),
});
const Spawned = z.object({ threadId: ThreadId }).loose();

async function resolved(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

export interface TaskToolDeps {
  context: ServiceContext;
  grants: GrantStore;
  admits: () => boolean;
  grantOf(caller: McpAttribution, tool: string, args: unknown): OutsideGrant;
  /** A thread in one of the grant's projects; throws otherwise. */
  thread(grant: OutsideGrant, id: string): Thread;
}

/**
 * `ace_task_control` for outside grants: delegated children stay on this machine, in the
 * parent's project, and are recorded under the grant like the threads it starts.
 */
export function registerTaskTool(registry: ToolRegistry, deps: TaskToolDeps): void {
  const { context, grants } = deps;
  const spawn = async (
    grant: OutsideGrant,
    parent: Thread,
    request: DelegationRequest,
    signal: AbortSignal,
  ) => {
    const checkout = context.store.getWorkspacePath(parent.workspaceId);
    const existing =
      request.workspace?.kind === "existing_worktree"
        ? await resolved(request.workspace.path)
        : undefined;
    if (!checkout || !spawnAllowed(request, (await resolved(checkout)) ?? checkout, existing))
      return { ok: false, error: "forbidden" };
    const requestId = grantKey(grant.id, request.requestId);
    if (!requestId) return { ok: false, error: "invalid_arguments" };
    const control = context.services.agentControl;
    if (!control || !parent.rootAgentId) return { ok: false, error: "unavailable" };
    const caller = {
      threadId: parent.id,
      agentId: AgentId.parse(parent.rootAgentId),
      sessionId: `mcp-grant:${grant.id}`,
    };
    const response = await control.port.execute(
      caller,
      { op: "delegate_task", ...request, requestId },
      signal,
    );
    const child = Spawned.safeParse(response.data);
    if (response.ok && child.success) {
      const threadId = child.data.threadId;
      context.store.atomic(() => {
        if (!context.store.getThread(threadId)?.startedByClient)
          context.store.appendEvents(threadId, [
            {
              type: "thread.updated",
              startedByClient: { kind: "mcp_client", grantId: grant.id, name: grant.name },
            },
          ]);
        grants.noteThread(grant.id, threadId, "started");
      });
    }
    return { ok: response.ok, data: response.data, error: response.code };
  };
  registry.register({
    name: "ace_task_control",
    description:
      "Spawn (threads:start), inspect, or cancel (threads:stop) a delegated task in an allowed project, on this machine. Cannot approve permissions.",
    input: TaskInput,
    output,
    capability: "agents",
    timeoutMs: 15000,
    async run(input, { caller, signal }) {
      const grant = deps.grantOf(caller, "ace_task_control", input);
      const operation = input.operation;
      if (operation.op !== "task.status" && !deps.admits())
        return { ok: false, error: "unavailable" };
      if (operation.op === "task.spawn")
        return spawn(grant, deps.thread(grant, operation.parentId), operation.request, signal);
      deps.thread(grant, operation.threadId);
      if (operation.op === "task.status") {
        const response = await cliControl(context)(operation, signal);
        return { ok: response.ok, data: response.data, error: response.code };
      }
      const key = grantKey(grant.id, operation.key);
      if (!key) return { ok: false, error: "invalid_arguments" };
      const response = await cliControl(context)({ ...operation, key }, signal);
      return { ok: response.ok, data: response.data, error: response.code };
    },
  });
}
