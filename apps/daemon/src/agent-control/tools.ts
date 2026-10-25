import { oldestTitleInput } from "../engine/title-input.ts";
import { provisionalTitle } from "../engine/thread-title.ts";
import {
  AgentControlOperation,
  DelegationRequest,
  type AgentControlResult,
  type MachineMessage,
  type McpAttribution,
  type ThreadId,
} from "@ace/protocol";
import type { AgentControlPort } from "@ace/mcp-server";
import { decodeTextPage } from "@ace/projection";
import { roleTask, withRoleContext, type RoleLookup } from "./run-roles.ts";
import { remainingWaitSeconds } from "./wait-deadline.ts";
import type { Store } from "../store.ts";
import type { DelegationService } from "./delegations.ts";
import { controlCommandId } from "./delegations.ts";
import { childTaskView } from "./task-view.ts";
import { settleThread, unsettleThread } from "./thread-settle.ts";
import { findProjects } from "./projects.ts";
import { queueControl } from "./queue-control.ts";
import { createForks } from "./forks.ts";
import {
  accountScope,
  knownModel,
  resolveSelection,
  type OpenSelection,
} from "./selection-defaults.ts";
import { conversationTool, type ConversationStartPort } from "./conversation-tools.ts";
import { AgentControlError } from "./failure.ts";
import type { ModelLoadBudget } from "./model-load-budget.ts";
import {
  batchDuplicateRoleProblem,
  internalRole,
  normalizeRole,
  roleProblem,
} from "./role-names.ts";

export type ExtensionOperation = Extract<
  AgentControlOperation,
  {
    op: "automation.manage" | "offshift" | "thread.handoff" | "preview.list" | "preview.close";
  }
>;
export type ThreadOwnerOperation = Extract<
  AgentControlOperation,
  {
    op:
      | "thread.read"
      | "thread.rename"
      | "thread.regenerate_title"
      | "thread.settle"
      | "thread.snooze";
  }
>;
function threadOwnerOperation(operation: AgentControlOperation): ThreadOwnerOperation | undefined {
  switch (operation.op) {
    case "thread.read":
    case "thread.rename":
    case "thread.regenerate_title":
    case "thread.settle":
    case "thread.snooze":
      return operation;
    default:
      return undefined;
  }
}
/**
 * Every name check a batch can meet before anything is created, so a batch never
 * half-starts and remote-machine children get the same naming rules as local ones.
 */
function checkNames(requests: DelegationRequest[]): void {
  const seen = new Set<string>();
  for (const request of requests) {
    const problem = roleProblem(request.role);
    if (problem)
      throw new AgentControlError("invalid_arguments", "generic_role", undefined, problem);
    if (internalRole(request.role)) continue;
    const name = normalizeRole(request.role);
    if (seen.has(name))
      throw new AgentControlError(
        "invalid_arguments",
        "duplicate_role",
        undefined,
        batchDuplicateRoleProblem(request.role),
      );
    seen.add(name);
  }
}
export type PrOwnerOperation = Extract<
  AgentControlOperation,
  { op: "thread.link_pr" | "thread.unlink_pr" | "thread.list_prs" }
>;
/** Typed owner ports are capability-gated. They cannot carry an approval or arbitrary command. */
export interface AgentControlExtensions {
  startConversation?: ConversationStartPort;
  delegateWorkspace?(
    caller: McpAttribution,
    request: import("@ace/protocol").DelegationRequest,
    signal: AbortSignal,
    budget?: ModelLoadBudget,
  ): Promise<import("@ace/protocol").DelegationRecord>;
  /** Canonical client thread/Forge owners register here without expanding agent authority. */
  thread?(
    caller: McpAttribution,
    operation: ThreadOwnerOperation,
    signal: AbortSignal,
  ): Promise<AgentControlResult>;
  pr?(
    caller: McpAttribution,
    operation: PrOwnerOperation,
    signal: AbortSignal,
  ): Promise<AgentControlResult>;
  execute?(
    caller: McpAttribution,
    operation: ExtensionOperation,
    signal: AbortSignal,
  ): Promise<AgentControlResult>;
  snooze?(thread: ThreadId, until: number | null): Promise<void>;
  /** Other paired machines (ADR 0078); their children join wait and agents_status. */
  machines?: MachinePort;
  /** Carry a project or the calling thread to another paired machine (ADR 0101). */
  transfer?(
    caller: McpAttribution,
    operation: Extract<AgentControlOperation, { op: "transfer" }>,
  ): Promise<AgentControlResult>;
  /** The person's role settings, for `delegate` tasks with runRole. */
  runRole?: RoleLookup;
}
export interface MachinePort {
  list(caller: McpAttribution): Promise<AgentControlResult>;
  delegate(
    caller: McpAttribution,
    request: DelegationRequest,
    signal: AbortSignal,
  ): Promise<ThreadId>;
  /** The caller delegated this child to another machine. */
  owns(caller: McpAttribution, id: ThreadId): boolean;
  status(id: ThreadId): unknown;
  cancel(id: ThreadId): Promise<AgentControlResult>;
  /** Follow-up work for a child there; the answer says how it arrives, as for a local child. */
  message(id: ThreadId, message: MachineMessage): Promise<AgentControlResult>;
}
export function createAgentControlPort(
  store: Store,
  service: DelegationService,
  extensions: AgentControlExtensions = {},
): AgentControlPort {
  const forks = createForks(store, service, service.conversations);
  /** One call, holding `held.budget` (when a step made one) until the call returns. */
  async function dispatch(
    caller: McpAttribution,
    value: AgentControlOperation,
    signal: AbortSignal,
    held: { budget?: ModelLoadBudget },
  ): Promise<AgentControlResult> {
    const operation = AgentControlOperation.parse(value);
    signal.throwIfAborted();
    // Authenticate again at the mutation boundary, including direct host callers.
    if (!store.getMcpAgent(caller.threadId, caller.agentId))
      return { ok: false, code: "forbidden" };
    const callerProvider = store.getThread(caller.threadId)?.provider;
    // An agent may leave the provider (and an ACP model's agent ids) for ace to resolve.
    // The account comes first: a label becomes its id and fixes the provider, and a loose model
    // name is then matched against that account's catalog alone. A name that is not an exact
    // catalog id is matched only after every account it could run on has loaded its models, so
    // a cold account's closer match is never lost to a warm account's weaker one.
    const list = (options: import("@ace/protocol").ModelListOptions) => service.listModels(options);
    // This call's one budget for waiting on model lists, made when a step first needs it.
    const loadBudget = () => (held.budget ??= service.loadBudget(signal));
    const resolved = async <T extends OpenSelection>(selection: T) => {
      const account =
        selection.accountId && !selection.machine
          ? service.accountNamed(selection.provider, selection.accountId)
          : undefined;
      const chosen: T = account
        ? {
            ...selection,
            accountId: account.id,
            provider: selection.provider ?? account.provider,
          }
        : selection;
      if (!chosen.machine && !knownModel(chosen, list))
        await service.warmModels(
          chosen.provider ? accountScope(chosen.provider, chosen.accountId) : {},
          loadBudget(),
        );
      const result = resolveSelection(chosen, callerProvider ?? "codex", list);
      // An ACP agent's own login is not in the account list: its source-qualified identity
      // selects it, so the name the agent gave becomes that identity, not an account id.
      if (result.provider !== "acp" || !result.accountId || account || result.machine)
        return result;
      const { accountId, ...identity } = result;
      return { ...identity, instanceId: identity.instanceId ?? accountId };
    };
    const machines = extensions.machines;
    if (
      (operation.op === "agent.status" || operation.op === "agent.cancel") &&
      machines?.owns(caller, operation.threadId)
    )
      return operation.op === "agent.cancel"
        ? machines.cancel(operation.threadId)
        : { ok: true, data: machines.status(operation.threadId) };
    if (
      (operation.op === "thread.message" || operation.op === "agent.message") &&
      machines?.owns(caller, operation.threadId)
    )
      return machines.message(operation.threadId, {
        requestId: operation.requestId,
        text: operation.text,
        delivery: operation.delivery ?? "steer",
      });
    if ("threadId" in operation) {
      const read = [
        "thread.read",
        "thread.read_output",
        "thread.search",
        "queue.list",
        "preview.list",
        "agent.status",
        "agent.result",
      ].includes(operation.op);
      if (!service.authorize(caller, operation.threadId, !read))
        return { ok: false, code: "forbidden" };
    }
    const owned = threadOwnerOperation(operation);
    if (owned && extensions.thread) {
      const result = await extensions.thread(caller, owned, signal);
      signal.throwIfAborted();
      if (result.code !== "unsupported") {
        if (result.ok && (owned.op === "thread.rename" || owned.op === "thread.regenerate_title"))
          store.appendEvents(owned.threadId, [{ type: "thread.updated", titleSource: "agent" }]);
        return result;
      }
    }
    const conversation = await conversationTool(
      store,
      service,
      caller,
      operation.op === "thread.start" ? await resolved(operation) : operation,
      signal,
      extensions.startConversation,
      operation.op === "thread.start" ? loadBudget() : undefined,
    );
    if (conversation) return conversation;
    switch (operation.op) {
      case "agents.catalog": {
        const { op: _op, ...input } = operation;
        return { ok: true, data: service.catalog(caller, input) };
      }
      case "agent.status":
      case "agent.result": {
        const child = childTaskView(store, service.journal, operation.threadId);
        if (!child || !service.authorize(caller, operation.threadId, true))
          return { ok: false, code: "forbidden" };
        const { record, view, available } = child;
        if (operation.op === "agent.result" && (!available || !record.outcome))
          return { ok: false, code: "not_ready", data: view };
        return {
          ok: true,
          data: { ...view, ...(available && record.outcome ? { outcome: record.outcome } : {}) },
        };
      }
      case "machines":
        return machines ? machines.list(caller) : { ok: false, code: "unsupported" };
      case "transfer":
        return extensions.transfer
          ? extensions.transfer(caller, operation)
          : { ok: false, code: "unsupported" };
      case "delegate_task": {
        const startedAt = service.now();
        /** Every refusal a task can meet before anything is created, so a batch never half-starts. */
        const check = async (request: DelegationRequest) => {
          if (request.project && !request.machine)
            throw new AgentControlError(
              "invalid_arguments",
              "project_without_machine",
              undefined,
              "project names a project on another machine; pass machine too.",
            );
          if (request.machine) {
            if (!machines) throw new AgentControlError("machine_unavailable", "no_machines");
            return undefined;
          }
          if (request.workspace && extensions.delegateWorkspace) return undefined;
          if (request.workspace?.kind && request.workspace.kind !== "project")
            throw new Error("Workspace owner unavailable");
          const configured = await service.prepareModels(caller, request, loadBudget());
          signal.throwIfAborted();
          return configured;
        };
        const create = async (
          request: DelegationRequest,
          configured: string | undefined,
        ): Promise<{ childId: ThreadId }> => {
          if (request.machine && machines)
            return { childId: await machines.delegate(caller, request, signal) };
          if (request.workspace && extensions.delegateWorkspace)
            return extensions.delegateWorkspace(caller, request, signal, loadBudget());
          return service.delegate(caller, request, configured);
        };
        const delegateOne = async (request: DelegationRequest) =>
          create(request, await check(request));
        const { op: _op, tasks, await: mode, timeoutSeconds, ...single } = operation;
        if (!tasks) {
          const singleRequest = DelegationRequest.parse(await resolved(single));
          checkNames([singleRequest]);
          const child = await delegateOne(singleRequest);
          if (operation.machine && (operation.waitMs !== undefined || operation.wait)) {
            const waited = await service.monitor.wait(
              caller,
              {
                threadIds: [child.childId],
                mode: "all",
                timeoutSeconds: Math.ceil((operation.waitMs ?? 600000) / 1000),
              },
              signal,
            );
            return { ...waited, data: { threadId: child.childId, wait: waited.data } };
          }
          const outcome =
            operation.waitMs !== undefined || operation.wait
              ? await service.waitBounded(caller, child.childId, signal, operation.waitMs ?? 600000)
              : undefined;
          // Whether the child started or waits for a run slot, and its queue place.
          const queue = service.queueFacts(child.childId);
          return {
            ok: true,
            data: {
              threadId: child.childId,
              queued: queue !== undefined,
              ...(queue ? { ...queue } : {}),
              ...(outcome ? { outcome } : {}),
            },
          };
        }
        // Checked first, then admitted in order. Children past the parent's free slots queue.
        // Stable per-task requestIds make a retried batch create nothing new.
        // A runRole fills provider, model, effort and tier before the usual resolution; a
        // role's choice that cannot run is refused with the role named, never swapped silently.
        const filled = tasks.map((task) => roleTask(task, extensions.runRole));
        const requests: DelegationRequest[] = [];
        for (const { task } of filled) requests.push(DelegationRequest.parse(await resolved(task)));
        checkNames(requests);
        const configured: (string | undefined)[] = [];
        for (const [index, request] of requests.entries())
          configured.push(await withRoleContext(filled[index]?.role, () => check(request)));
        const threadIds: ThreadId[] = [];
        for (const [index, request] of requests.entries())
          threadIds.push(
            (await withRoleContext(filled[index]?.role, () => create(request, configured[index])))
              .childId,
          );
        if (!mode || mode === "none")
          return {
            ok: true,
            // Per child whether it started or waits for a run slot, and its queue place.
            data: {
              threadIds,
              launches: threadIds.map((threadId) => {
                const queue = service.queueFacts(threadId);
                return { threadId, queued: queue !== undefined, ...(queue ? { ...queue } : {}) };
              }),
            },
          };
        const waited = await service.monitor.wait(
          caller,
          {
            threadIds,
            mode,
            timeoutSeconds: remainingWaitSeconds(timeoutSeconds ?? 120, startedAt, service.now()),
          },
          signal,
        );
        return { ...waited, data: { threadIds, wait: waited.data } };
      }
      case "thread.create": {
        const { op: _op, title: _title, ...selection } = operation;
        const request = {
          ...selection,
          task: "Await launch",
          role: operation.title,
          wait: false,
          estimatedLoad: 0,
        };
        const configured = await service.prepareModels(caller, request, loadBudget());
        signal.throwIfAborted();
        const child = service.prepare(caller, request, configured);
        return { ok: true, data: { threadId: child.childId } };
      }
      case "thread.launch": {
        const record = service.journal.get(operation.threadId);
        if (!record || record.phase !== "created") return { ok: false, code: "not_ready" };
        service.launch(record, operation.text);
        return { ok: true };
      }
      case "agent.message":
      case "thread.message": {
        if (
          operation.op === "agent.message" &&
          !service.journal.isDescendant(operation.threadId, caller.threadId)
        )
          return { ok: false, code: "forbidden" };
        // An agent's own children get it now where their provider steers; any other thread
        // (one it started, or one of the person's) gets it once its turn ends.
        const delivery =
          operation.delivery ??
          (service.journal.isDescendant(operation.threadId, caller.threadId) ? "steer" : "queue");
        const result =
          delivery === "restart"
            ? service.restartMessage(
                caller,
                operation.requestId,
                operation.threadId,
                operation.text,
              )
            : service.message(
                caller,
                operation.requestId,
                operation.threadId,
                operation.text,
                delivery,
              );
        if (!result.ok) return { ok: false, code: "unavailable" };
        // Says whether the message went in now or waits, so the sender never assumes delivery.
        const reading = service.arrival(
          caller,
          operation.requestId,
          operation.threadId,
          delivery === "restart",
        );
        return reading.ok
          ? { ok: true, data: { arrival: reading.arrival } }
          : { ok: false, code: "unavailable", hint: reading.hint };
      }
      case "wait":
        return service.monitor.wait(caller, operation, signal);
      case "agents.status":
        return { ok: true, data: service.monitor.snapshot(caller) };
      case "thread.read":
        return {
          ok: true,
          data: {
            thread: store.getThread(operation.threadId),
            metadata: service.journal.readMetadata(operation.threadId),
            linkedPrs: store.getThread(operation.threadId)?.details?.linkedPrs ?? [],
            ...store.readBoundedItemPage(
              operation.threadId,
              operation.before ?? store.headSeq() + 1,
              operation.limit,
              48 * 1024,
            ),
          },
        };
      case "thread.read_output": {
        if (store.outputThread(operation.streamId) !== operation.threadId)
          return { ok: false, code: "forbidden" };
        // Agents get text, never the stored bytes. Four bytes always hold one whole character.
        const page = store.readOutputBytes(
          operation.streamId,
          operation.offset,
          Math.max(4, operation.limit),
        );
        return { ok: true, data: decodeTextPage(page, operation.offset, page.encoding) };
      }
      case "thread.search": {
        // Search owns FTS and paging. Scope is enforced in its query, before ranking/pagination.
        const data = await store.searchQueries.query({
          text: operation.query,
          scope: "items",
          mode: "tokens",
          filters: { threadId: operation.threadId },
          limit: operation.limit,
          ...(operation.cursor ? { cursor: operation.cursor } : {}),
        });
        signal.throwIfAborted();
        return { ok: true, data };
      }
      case "agent.cancel":
      case "thread.interrupt": {
        if (
          operation.op === "agent.cancel" &&
          !service.journal.isDescendant(operation.threadId, caller.threadId)
        )
          return { ok: false, code: "forbidden" };
        const result = service.command(
          controlCommandId(caller.threadId, operation.requestId, operation.op),
          { type: "thread.interrupt", threadId: operation.threadId, cascade: true },
        );
        return { ok: result.ok };
      }
      case "question.answer": {
        return store.atomic(() => {
          const interaction = store.getInteraction(operation.interactionId);
          if (
            operation.answer.kind !== "question" ||
            interaction?.request.kind !== "question" ||
            interaction.threadId !== operation.threadId
          )
            return { ok: false, code: "forbidden" as const };
          const result = service.command(
            controlCommandId(caller.threadId, operation.requestId, operation.op),
            {
              type: "interaction.resolve",
              interactionId: interaction.id,
              resolution: operation.answer,
            },
          );
          return { ok: result.ok, ...(result.ok ? {} : { code: "not_ready" as const }) };
        });
      }
      case "thread.rename":
        return store.atomic(() => {
          if (
            operation.onlyIfProvisional &&
            store.getThread(operation.threadId)?.titleSource !== "provisional"
          )
            return { ok: false, code: "not_ready" as const };
          store.appendEvents(operation.threadId, [
            { type: "thread.updated", title: operation.title, titleSource: "agent" },
          ]);
          return { ok: true };
        });
      case "thread.regenerate_title": {
        const oldest = oldestTitleInput(store, operation.threadId);
        if (!oldest) return { ok: false, code: "not_ready" };
        store.appendEvents(operation.threadId, [
          { type: "thread.updated", title: provisionalTitle(oldest), titleSource: "agent" },
        ]);
        return { ok: true };
      }
      case "thread.link_pr":
      case "thread.unlink_pr":
      case "thread.list_prs":
        return extensions.pr
          ? extensions.pr(caller, operation, signal)
          : { ok: false, code: "unsupported" };
      case "thread.settle":
        return settleThread(store, operation.threadId, service.now());
      case "thread.unsettle":
        return unsettleThread(store, operation.threadId, service.now());
      case "projects.list": {
        const current = store.getThread(caller.threadId)?.workspaceId;
        return {
          ok: true,
          data: { projects: findProjects(store, operation.query, operation.limit, current) },
        };
      }
      case "thread.snooze": {
        if (!extensions.snooze) return { ok: false, code: "unsupported" };
        await extensions.snooze(operation.threadId, operation.until);
        return { ok: true };
      }
      case "project.read":
      case "project.rename": {
        const thread = store.getThread(caller.threadId);
        const workspaceId = operation.workspaceId ?? thread?.workspaceId;
        if (!thread || thread.workspaceId !== workspaceId) return { ok: false, code: "forbidden" };
        return store.atomic((db) => {
          if (operation.op === "project.rename")
            db.prepare("UPDATE workspaces SET name=? WHERE id=?").run(operation.name, workspaceId);
          const row = db.prepare("SELECT id,name FROM workspaces WHERE id=?").get(workspaceId);
          return { ok: !!row, data: row };
        });
      }
      case "queue.list":
      case "queue.edit":
      case "queue.cancel":
      case "queue.steer":
      case "queue.reorder":
        return queueControl(service, caller, operation);
      case "thread.fork":
        return forks.fork(caller, operation, signal);
      case "thread.merge":
        return forks.merge(caller, operation);
      case "automation.manage":
      case "offshift":
      case "thread.handoff":
      case "preview.list":
      case "preview.close":
        return extensions.execute
          ? extensions.execute(caller, operation, signal)
          : { ok: false, code: "unsupported" };
      default:
        return { ok: false, code: "unsupported" };
    }
  }
  return {
    async execute(caller, value, signal) {
      // The call's hold on its budget ends with the call; a thread start that outlives it keeps
      // its own hold until it is done.
      const held: { budget?: ModelLoadBudget } = {};
      try {
        return await dispatch(caller, value, signal, held);
      } finally {
        held.budget?.end();
      }
    },
  };
}
