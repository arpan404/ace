import { AgentId, CliTree, type CliOperation, type AgentControlResult } from "@ace/protocol";
import { agentTaskView } from "../agent-control/task-view.ts";
import type { ServiceContext } from "./types.ts";
import type { SocketContext, SocketService } from "./socket.ts";

export function cliControl(context: ServiceContext) {
  return async (operation: CliOperation, signal: AbortSignal): Promise<AgentControlResult> => {
    const { store, services } = context;
    const owner = services.agentControl;
    const threadId = operation.op === "task.spawn" ? operation.parentId : operation.threadId;
    const thread = store.getThread(threadId);
    if (!thread) return { ok: false, code: "not_found" };
    if (!owner) return { ok: false, code: "unsupported" };
    const journal = owner.delegations.journal;
    const record = journal.get(threadId);
    const root = record?.rootId ?? journal.participant(threadId)?.root_id ?? threadId;
    const descendants = journal
      .family(root)
      .filter((edge) => journal.isDescendant(edge.childId, threadId));
    if (operation.op === "thread.tree") {
      const members = [threadId, ...descendants.map((edge) => edge.childId)];
      const data = members.map((id) => {
        const value = store.getThread(id);
        const edge = journal.get(id);
        return {
          threadId: id,
          status: value?.status ?? { state: "unresponsive" as const },
          pending: !!edge && edge.phase !== "settled",
        };
      });
      return { ok: true, data: CliTree.parse(data) };
    }
    if (operation.op === "task.status") {
      if (!record) return { ok: false, code: "not_found" };
      const agent = thread.rootAgentId && store.getMcpAgent(thread.id, thread.rootAgentId);
      const view = agentTaskView(
        thread,
        record,
        descendants.some((edge) => edge.phase !== "settled"),
        !!agent && ["idle", "blocked", "interrupted"].includes(agent.status.state),
      );
      return { ok: true, data: { ...view, outcome: record.outcome } };
    }
    const parent =
      operation.op === "task.spawn" ? thread : record && store.getThread(record.parentId);
    if (!parent?.rootAgentId) return { ok: false, code: "not_ready" };
    const caller = {
      threadId: parent.id,
      agentId: AgentId.parse(parent.rootAgentId),
      sessionId: "ace-cli",
    };
    return owner.port.execute(
      caller,
      operation.op === "task.spawn"
        ? { op: "delegate_task", ...operation.request }
        : { op: "agent.cancel", threadId, requestId: operation.key },
      signal,
    );
  };
}

export function createCliControlSession(context: SocketContext): SocketService {
  const lifetime = new AbortController();
  let pending = 0;
  return {
    close: () => lifetime.abort(),
    async handle(message) {
      if (message.type !== "cli.request") return false;
      const operation = message.operation;
      const threadId = operation.op === "task.spawn" ? operation.parentId : operation.threadId;
      const scope = ["thread.tree", "task.status"].includes(operation.op) ? "read" : "operate";
      let result: AgentControlResult;
      if (!context.authorize(scope) || !context.canReadThread(threadId))
        result = { ok: false, code: "forbidden" };
      else if (pending >= 8) result = { ok: false, code: "limit" };
      else if (!context.options.cliControl) result = { ok: false, code: "unsupported" };
      else {
        pending++;
        try {
          result = await context.options.cliControl(operation, lifetime.signal);
        } catch {
          result = { ok: false, code: "unavailable" };
        } finally {
          pending--;
        }
      }
      if (context.connected() && context.authorize(scope))
        context.send({ type: "cli.result", requestId: message.requestId, result });
      return true;
    },
  };
}
