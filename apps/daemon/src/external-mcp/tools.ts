import { z } from "zod";
import {
  DelegationRequest,
  DeviceId,
  ThreadListCursor,
  ThreadId,
  WorkspaceId,
  ProviderKind,
  type McpAttribution,
  type OutsideGrant,
} from "@ace/protocol";
import { ToolRegistry, nodeScheduler, type CallSignal } from "@ace/mcp-server";
import { PublicToolError } from "@ace/mcp-server/errors";
import type { ServiceContext } from "../services/types.ts";
import { cliControl } from "../services/cli-control.ts";
import { toolFailureReporter } from "../tool-failure-log.ts";
import type { GrantStore } from "./grants.ts";
import { grantOfCaller } from "./principals.ts";
import { missingScope, projectAllowed } from "./scopes.ts";

const output = z.object({
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
});
const idempotencyKey = z.string().regex(/^[a-zA-Z0-9_.-]{1,128}$/);
const ProjectRow = z.object({ id: z.string(), name: z.string() });

/** The device an outside grant's commands are recorded under (ADR 0117). */
export function grantDevice(grantId: string): DeviceId {
  return DeviceId.parse(`mcp-grant:${grantId}`);
}
/** A start or send keyed by grant and the client's own key, so a retry runs once. */
function commandId(grantId: string, key: string): string {
  return `external:${grantId}:${key}`;
}

/**
 * The outside endpoint's thread tools (ADR 0117). Which of them a client sees and may call is
 * decided by its grant's scopes (`scopes.ts`); each tool here also keeps to the grant's projects
 * and re-reads the grant, so a revoke or change applies to the call already in hand.
 */
export function externalTools(
  context: ServiceContext,
  grants: GrantStore,
  admits: () => boolean,
  callSignal?: CallSignal,
) {
  const registry = new ToolRegistry({
    scheduler: nodeScheduler,
    maxTools: 48,
    reportFailure: toolFailureReporter(context.log, context.id),
    ...(callSignal ? { callSignal } : {}),
  });
  /** The live grant behind a call, held to the scope this call needs. */
  const grantOf = (caller: McpAttribution, tool: string, args: unknown): OutsideGrant => {
    const id = grantOfCaller(caller.threadId);
    const grant = id === undefined ? undefined : grants.live(id);
    if (!grant) throw new PublicToolError("session_ended");
    if (missingScope(grant.scopes, tool, args)) throw new PublicToolError("tool_unavailable");
    return grant;
  };
  const thread = (grant: OutsideGrant, id: string) => {
    const value = context.store.getThread(ThreadId.parse(id));
    if (!value || !projectAllowed(grant.projects, value.workspaceId))
      throw new Error("Outside the grant's projects");
    return value;
  };
  const projects = (grant: OutsideGrant) =>
    z
      .array(ProjectRow)
      .parse(
        context.store
          .statement(
            "SELECT id,name FROM workspaces WHERE NOT EXISTS(SELECT 1 FROM workspace_unregistered WHERE workspace_id=workspaces.id) ORDER BY rowid DESC LIMIT 256",
          )
          .all(),
      )
      .filter((row) => projectAllowed(grant.projects, WorkspaceId.parse(row.id)));
  registry.register({
    name: "ace_projects_list",
    description: "List the projects this grant may use, with the ids other tools take.",
    input: z.object({}),
    output,
    riskClass: "read-only",
    capability: null,
    timeoutMs: 15000,
    async run(input, { caller }) {
      const grant = grantOf(caller, "ace_projects_list", input);
      return { ok: true, data: { projects: projects(grant) } };
    },
  });
  registry.register({
    name: "ace_models_list",
    description:
      "List models of the person's installed coding-agent CLIs, for ace_thread_run's provider and model.",
    input: z.object({
      provider: ProviderKind.optional(),
      offset: z.number().int().min(0).max(40960).default(0),
    }),
    output,
    riskClass: "read-only",
    capability: null,
    timeoutMs: 15000,
    async run(input, { caller }) {
      grantOf(caller, "ace_models_list", input);
      const models = context.services.models;
      if (!models) return { ok: false, error: "unavailable" };
      const page = models.list({
        offset: input.offset,
        limit: 100,
        ...(input.provider ? { provider: input.provider } : {}),
      });
      return {
        ok: true,
        data: {
          models: page.models
            .filter((model) => !model.hidden && !model.deprecated)
            .map((model) => ({
              provider: model.provider,
              model: model.id,
              name: model.displayName,
              ...(model.isDefault ? { default: true } : {}),
              ...(model.efforts.length
                ? { efforts: model.efforts.map((effort) => effort.id) }
                : {}),
            })),
          ...(page.nextOffset === undefined ? {} : { nextOffset: page.nextOffset }),
        },
      };
    },
  });
  registry.register({
    name: "ace_threads_list",
    description: "List threads in this grant's projects. Results are bounded.",
    input: z.object({
      before: ThreadListCursor.optional(),
      limit: z.number().int().min(1).max(100).default(20),
      project: WorkspaceId.optional(),
    }),
    output,
    riskClass: "read-only",
    capability: null,
    timeoutMs: 15000,
    async run(input, { caller, signal }) {
      signal.throwIfAborted();
      const grant = grantOf(caller, "ace_threads_list", input);
      if (input.project && !projectAllowed(grant.projects, input.project))
        return { ok: false, error: "forbidden" };
      const only =
        input.project ??
        (grant.projects !== "all" && grant.projects.length === 1 ? grant.projects[0] : undefined);
      const page = context.store.sidebarPage(
        { limit: input.limit, ...(only ? { project: only } : {}) },
        input.before,
      );
      // A grant limited to several projects sees only theirs.
      return {
        ok: true,
        data:
          grant.projects === "all"
            ? page
            : {
                ...page,
                threads: page.threads.filter((entry) =>
                  projectAllowed(grant.projects, entry.workspaceId),
                ),
              },
      };
    },
  });
  registry.register({
    name: "ace_thread_read",
    description: "Read a bounded transcript page from a thread in this grant's projects.",
    input: z.object({
      threadId: ThreadId,
      before: z.number().int().positive().optional(),
      limit: z.number().int().min(1).max(100).default(20),
    }),
    output,
    riskClass: "read-only",
    capability: null,
    timeoutMs: 15000,
    async run(input, { caller, signal }) {
      signal.throwIfAborted();
      const value = thread(grantOf(caller, "ace_thread_read", input), input.threadId);
      return {
        ok: true,
        data: {
          thread: value,
          ...context.store.readBoundedItemPage(
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
    riskClass: "read-only",
    capability: null,
    timeoutMs: 15000,
    async run(input, { caller, signal }) {
      thread(grantOf(caller, "ace_thread_status", input), input.threadId);
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
      "Start independent work using the person's installed CLI in an allowed project. Retry with the same idempotency key.",
    input: z.object({
      project: WorkspaceId,
      provider: ProviderKind,
      text: z.string().min(1).max(16384),
      model: z.string().max(256).optional(),
      idempotencyKey,
    }),
    output,
    capability: "thread_control",
    timeoutMs: 15000,
    async run(input, { caller, signal }) {
      const grant = grantOf(caller, "ace_thread_run", input);
      if (
        !admits() ||
        !projectAllowed(grant.projects, input.project) ||
        !context.store.getWorkspace(input.project)
      )
        return { ok: false, error: "forbidden" };
      signal.throwIfAborted();
      const delegations = context.services.agentControl?.delegations;
      if (!context.services.engine || !delegations) return { ok: false, error: "unavailable" };
      const client = { grantId: grant.id, name: grant.name };
      const receipt = delegations.commandFor(
        grantDevice(grant.id),
        commandId(grant.id, input.idempotencyKey),
        {
          type: "thread.create",
          workspaceId: input.project,
          provider: input.provider,
          model: input.model,
          origin: { kind: "mcp_client", client },
          input: [{ type: "text", text: input.text }],
        },
        (result) => {
          if (!result.threadId) return;
          // The thread names its starter in the same transaction as its receipt.
          context.store.appendEvents(result.threadId, [
            { type: "thread.updated", startedByClient: { kind: "mcp_client", ...client } },
          ]);
          grants.noteThread(grant.id, result.threadId, "started");
        },
      );
      return { ok: receipt.ok, data: receipt, error: receipt.error };
    },
  });
  registry.register({
    name: "ace_thread_send",
    description:
      "Queue or steer a message on a thread in an allowed project. This grants no permission approval authority.",
    input: z.object({
      threadId: ThreadId,
      text: z.string().min(1).max(16384),
      delivery: z.enum(["queue", "steer"]).default("queue"),
      idempotencyKey,
    }),
    output,
    capability: "thread_control",
    timeoutMs: 15000,
    async run(input, { caller, signal }) {
      const grant = grantOf(caller, "ace_thread_send", input);
      thread(grant, input.threadId);
      const delegations = context.services.agentControl?.delegations;
      if (!admits() || !context.services.engine || !delegations)
        return { ok: false, error: "unavailable" };
      signal.throwIfAborted();
      const receipt = delegations.commandFor(
        grantDevice(grant.id),
        commandId(grant.id, input.idempotencyKey),
        {
          type: "thread.send",
          threadId: input.threadId,
          input: [{ type: "text", text: input.text }],
          delivery: input.delivery,
          origin: { kind: "mcp_client", client: { grantId: grant.id, name: grant.name } },
        },
        () => grants.noteThread(grant.id, input.threadId, "messaged"),
      );
      return { ok: receipt.ok, data: receipt, error: receipt.error };
    },
  });
  registry.register({
    name: "ace_thread_stop",
    description: "Stop a thread's work, its delegated children included, in an allowed project.",
    input: z.object({ threadId: ThreadId, idempotencyKey }),
    output,
    capability: "thread_control",
    timeoutMs: 15000,
    async run(input, { caller, signal }) {
      const grant = grantOf(caller, "ace_thread_stop", input);
      thread(grant, input.threadId);
      const delegations = context.services.agentControl?.delegations;
      if (!context.services.engine || !delegations) return { ok: false, error: "unavailable" };
      signal.throwIfAborted();
      const receipt = delegations.commandFor(
        grantDevice(grant.id),
        commandId(grant.id, input.idempotencyKey),
        { type: "thread.interrupt", threadId: input.threadId, cascade: true },
      );
      return { ok: receipt.ok, data: receipt, error: receipt.error };
    },
  });
  registry.register({
    name: "ace_task_control",
    description:
      "Spawn (threads:start), inspect, or cancel (threads:stop) a delegated task in an allowed project. Cannot approve permissions.",
    input: z.object({
      operation: z.union([
        z.object({ op: z.literal("task.spawn"), parentId: ThreadId, request: DelegationRequest }),
        z.object({ op: z.literal("task.status"), threadId: ThreadId }),
        z.object({ op: z.literal("task.cancel"), threadId: ThreadId, key: idempotencyKey }),
      ]),
    }),
    output,
    capability: "agents",
    timeoutMs: 15000,
    async run(input, { caller, signal }) {
      const grant = grantOf(caller, "ace_task_control", input);
      if (input.operation.op !== "task.status" && !admits())
        return { ok: false, error: "unavailable" };
      thread(
        grant,
        input.operation.op === "task.spawn" ? input.operation.parentId : input.operation.threadId,
      );
      const response = await cliControl(context)(input.operation, signal);
      return { ok: response.ok, data: response.data, error: response.code };
    },
  });
  return registry;
}
