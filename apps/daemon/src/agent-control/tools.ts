import { oldestTitleInput } from "../engine/title-input.ts";
import { provisionalTitle } from "../engine/thread-title.ts";
import {
  AgentControlOperation,
  type AgentControlResult,
  type McpAttribution,
  type ThreadId,
} from "@ace/protocol";
import type { AgentControlPort } from "@ace/mcp-server";
import type { Store } from "../store.ts";
import type { DelegationService } from "./delegations.ts";
import { controlCommandId } from "./delegations.ts";

export type ExtensionOperation = Extract<
  AgentControlOperation,
  {
    op:
      | "thread.fork"
      | "thread.merge"
      | "queue.edit"
      | "queue.reorder"
      | "automation.manage"
      | "thread.handoff"
      | "preview.list"
      | "preview.close";
  }
>;
export type ThreadOwnerOperation = Extract<
  AgentControlOperation,
  {
    op:
      | "thread.read"
      | "thread.rename"
      | "thread.regenerate_title"
      | "thread.link_pr"
      | "thread.settle"
      | "thread.snooze";
  }
>;
function threadOwnerOperation(operation: AgentControlOperation): ThreadOwnerOperation | undefined {
  switch (operation.op) {
    case "thread.read":
    case "thread.rename":
    case "thread.regenerate_title":
    case "thread.link_pr":
    case "thread.settle":
    case "thread.snooze":
      return operation;
    default:
      return undefined;
  }
}
/** Typed owner ports are capability-gated. They cannot carry an approval or arbitrary command. */
export interface AgentControlExtensions {
  /** Canonical client thread/Forge owners register here without expanding agent authority. */
  thread?(
    caller: McpAttribution,
    operation: ThreadOwnerOperation,
    signal: AbortSignal,
  ): Promise<AgentControlResult>;
  execute?(
    caller: McpAttribution,
    operation: ExtensionOperation,
    signal: AbortSignal,
  ): Promise<AgentControlResult>;
  snooze?(thread: ThreadId, until: number | null): Promise<void>;
}
export function createAgentControlPort(
  store: Store,
  service: DelegationService,
  extensions: AgentControlExtensions = {},
): AgentControlPort {
  return {
    async execute(caller, value, signal) {
      const operation = AgentControlOperation.parse(value);
      signal.throwIfAborted();
      // Authenticate again at the mutation boundary, including direct host callers.
      if (!store.getMcpAgent(caller.threadId, caller.agentId))
        return { ok: false, code: "forbidden" };
      if ("threadId" in operation) {
        const read = [
          "thread.read",
          "thread.read_output",
          "thread.wait",
          "thread.search",
          "preview.list",
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
      switch (operation.op) {
        case "delegate_task": {
          const { op: _op, ...request } = operation;
          const configured = await service.prepareModels(caller, request);
          signal.throwIfAborted();
          const child = service.delegate(caller, request, configured);
          const outcome = operation.wait
            ? await service.wait(caller, child.childId, signal)
            : undefined;
          return { ok: true, data: { threadId: child.childId, ...(outcome ? { outcome } : {}) } };
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
          const configured = await service.prepareModels(caller, request);
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
        case "thread.message": {
          const result = service.message(
            caller,
            operation.requestId,
            operation.threadId,
            operation.text,
            operation.delivery,
          );
          return { ok: result.ok, ...(result.ok ? {} : { code: "unavailable" as const }) };
        }
        case "thread.wait":
          return { ok: true, data: await service.wait(caller, operation.threadId, signal) };
        case "thread.read":
          return {
            ok: true,
            data: {
              thread: store.getThread(operation.threadId),
              metadata: service.journal.readMetadata(operation.threadId),
              ...store.readItemPage(
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
          return {
            ok: true,
            data: store.readOutput(operation.streamId, operation.offset, operation.limit),
          };
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
        case "thread.interrupt": {
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
        case "thread.link_pr": {
          const url = new URL(operation.url);
          if (
            url.protocol !== "https:" ||
            url.hostname !== "github.com" ||
            !/^\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(url.pathname) ||
            url.search ||
            url.hash ||
            url.username ||
            url.password
          )
            return { ok: false, code: "invalid" };
          store.atomic(() =>
            service.journal.metadata(operation.threadId, { prUrl: operation.url }),
          );
          return { ok: true };
        }
        case "thread.settle": {
          if (
            !["done", "failed", "new"].includes(
              store.getThread(operation.threadId)?.status.state ?? "",
            )
          )
            return { ok: false, code: "not_ready" };
          const result = service.command(
            controlCommandId(operation.threadId, "settle", operation.op),
            { type: "thread.archive", threadId: operation.threadId },
          );
          return { ok: result.ok };
        }
        case "thread.snooze": {
          if (!extensions.snooze) return { ok: false, code: "unsupported" };
          await extensions.snooze(operation.threadId, operation.until);
          return { ok: true };
        }
        case "project.read":
        case "project.rename": {
          const thread = store.getThread(caller.threadId);
          if (thread?.workspaceId !== operation.workspaceId)
            return { ok: false, code: "forbidden" };
          return store.atomic((db) => {
            if (operation.op === "project.rename")
              db.prepare("UPDATE workspaces SET name=? WHERE id=?").run(
                operation.name,
                operation.workspaceId,
              );
            const row = db
              .prepare("SELECT id,name FROM workspaces WHERE id=?")
              .get(operation.workspaceId);
            return { ok: !!row, data: row };
          });
        }
        case "thread.fork":
        case "thread.merge":
        case "queue.edit":
        case "queue.reorder":
        case "automation.manage":
        case "thread.handoff":
        case "preview.list":
        case "preview.close":
          return extensions.execute
            ? extensions.execute(caller, operation, signal)
            : { ok: false, code: "unsupported" };
      }
    },
  };
}
