import { z } from "zod";
import {
  DeviceId,
  ThreadListCursor,
  ThreadId,
  WorkspaceId,
  ProviderKind,
  type CatalogModel,
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
import { registerTaskTool } from "./task-tool.ts";

const output = z.object({
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
});
const idempotencyKey = z.string().regex(/^[a-zA-Z0-9_.-]{1,128}$/);
const ProjectRows = z.array(z.object({ id: z.string(), name: z.string() }));
const ProjectsInput = z.object({});
const ModelsInput = z.object({
  provider: ProviderKind.optional(),
  offset: z.number().int().min(0).max(40960).default(0),
});
const ThreadsInput = z.object({
  before: ThreadListCursor.optional(),
  limit: z.number().int().min(1).max(100).default(20),
  project: WorkspaceId.optional(),
});
const ReadInput = z.object({
  threadId: ThreadId,
  before: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(100).default(20),
});
const StatusInput = z.object({ threadId: ThreadId });
const RunInput = z.object({
  project: WorkspaceId,
  provider: ProviderKind,
  text: z.string().min(1).max(16384),
  model: z.string().max(256).optional(),
  idempotencyKey,
});
const SendInput = z.object({
  threadId: ThreadId,
  text: z.string().min(1).max(16384),
  delivery: z.enum(["queue", "steer"]).default("queue"),
  idempotencyKey,
});
const StopInput = z.object({ threadId: ThreadId, idempotencyKey });

/** One model as an outside client picks it: what ace_thread_run takes, and little else. */
function modelRow(model: CatalogModel) {
  const row: { provider: string; model: string; name: string; default?: true; efforts?: string[] } =
    { provider: model.provider, model: model.id, name: model.displayName };
  if (model.isDefault) row.default = true;
  if (model.efforts.length) row.efforts = model.efforts.map((effort) => effort.id);
  return row;
}
/** The device an outside grant's commands are recorded under (ADR 0122). */
export function grantDevice(grantId: string): DeviceId {
  return DeviceId.parse(`mcp-grant:${grantId}`);
}
/** A start or send keyed by grant and the client's own key, so a retry runs once. */
function commandId(grantId: string, key: string): string {
  return `external:${grantId}:${key}`;
}

/**
 * The outside endpoint's thread tools (ADR 0122). Which of them a client sees and may call is
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
    ProjectRows.parse(
      context.store
        .statement(
          "SELECT id,name FROM workspaces WHERE NOT EXISTS(SELECT 1 FROM workspace_unregistered WHERE workspace_id=workspaces.id) ORDER BY rowid DESC LIMIT 256",
        )
        .all(),
    ).filter((row) => projectAllowed(grant.projects, WorkspaceId.parse(row.id)));
  registry.register({
    name: "ace_projects_list",
    description: "List the projects this grant may use, with the ids other tools take.",
    input: ProjectsInput,
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
    input: ModelsInput,
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
          models: page.models.filter((model) => !model.hidden && !model.deprecated).map(modelRow),
          ...(page.nextOffset === undefined ? {} : { nextOffset: page.nextOffset }),
        },
      };
    },
  });
  registry.register({
    name: "ace_threads_list",
    description: "List threads in this grant's projects. Results are bounded.",
    input: ThreadsInput,
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
      // Only the grant's threads and the cursor to the next page: the sidebar's window holds
      // per-project counts and attention for every project, which a limited grant can't see.
      return {
        ok: true,
        data: {
          threads: page.threads.filter((entry) =>
            projectAllowed(grant.projects, entry.workspaceId),
          ),
          before: page.window?.before ?? null,
        },
      };
    },
  });
  registry.register({
    name: "ace_thread_read",
    description: "Read a bounded transcript page from a thread in this grant's projects.",
    input: ReadInput,
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
    input: StatusInput,
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
    input: RunInput,
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
          origin: { kind: "person", client },
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
    input: SendInput,
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
          origin: { kind: "person", client: { grantId: grant.id, name: grant.name } },
        },
        () => grants.noteThread(grant.id, input.threadId, "messaged"),
      );
      return { ok: receipt.ok, data: receipt, error: receipt.error };
    },
  });
  registry.register({
    name: "ace_thread_stop",
    description: "Stop a thread's work, its delegated children included, in an allowed project.",
    input: StopInput,
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
  registerTaskTool(registry, { context, grants, admits, grantOf, thread });
  return registry;
}
