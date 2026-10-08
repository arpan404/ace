import { McpProviderSessions } from "./mcp-provider-sessions.ts";
import { randomUUID } from "node:crypto";
import { ItemId, type McpScope } from "@ace/protocol";
import {
  type StatusReader,
  mcpStatusGroups,
  ToolRegistry,
  nodeScheduler,
  registerBuiltins,
  startMcpServer,
  type Toolkit,
  type McpIntentPort,
  type CallObserver,
} from "@ace/mcp-server";
import type { Store } from "./store.ts";

export async function startDaemonMcp(
  store: Store,
  toolkits: readonly Toolkit[] = [],
  spawn?: McpIntentPort["spawn"],
  observations?: { observeCall: CallObserver; lease(sessionId: string): () => void },
  status?: StatusReader,
) {
  const registry = new ToolRegistry({
    scheduler: nodeScheduler,
    ...(observations ? { observeCall: observations.observeCall } : {}),
  });
  registerBuiltins(
    registry,
    {
      async thread(caller, signal) {
        signal.throwIfAborted();
        const thread = store.getThread(caller.threadId);
        if (!thread) throw new Error("Unknown thread");
        return thread;
      },
      async agents(caller, page, signal) {
        signal.throwIfAborted();
        const agents = store.listMcpAgents(caller.threadId, page.cursor ?? "", page.limit + 1);
        const more = agents.length > page.limit;
        if (more) agents.pop();
        return { agents, nextCursor: more ? (agents.at(-1)?.id ?? null) : null };
      },
    },
    {
      async notify(intent, signal) {
        const intentId = randomUUID();
        const at = Date.now();
        signal.throwIfAborted();
        store.enqueueMcpIntent(
          intentId,
          intent,
          [
            {
              type: "item.created",
              item: {
                type: "notice",
                id: ItemId.parse(randomUUID()),
                agentId: intent.agentId,
                createdAt: at,
                complete: true,
                level: intent.notice.level,
                text: intent.notice.text,
                raw: [],
              },
            },
          ],
          at,
        );
        return { intentId };
      },
      async spawn(intent, signal) {
        if (spawn) return spawn(intent, signal);
        const intentId = randomUUID();
        signal.throwIfAborted();
        store.enqueueMcpIntent(intentId, intent, [], Date.now());
        return { intentId };
      },
    },
  );
  for (const toolkit of toolkits) toolkit.register(registry);
  const server = await startMcpServer({
    registry,
    status:
      status ??
      ((caller) => ({
        permissionMode: store.getThread(caller.threadId)?.permission?.effective ?? null,
      })),
  });
  return {
    url: server.url,
    toolsChanged: server.toolsChanged,
    action: (name: string, input: unknown) => registry.action(name, input),
    providers: new McpProviderSessions(),
    groups(
      threadId: import("@ace/protocol").ThreadId,
      capabilities: import("@ace/protocol").McpCapability[],
    ) {
      const thread = store.getThread(threadId);
      if (!thread?.rootAgentId) return [];
      const state = status?.({
        threadId,
        agentId: thread.rootAgentId,
        sessionId: "sources",
      });
      return mcpStatusGroups(
        registry.capabilities(),
        capabilities,
        state?.disabled,
        state?.permissionMode,
      )
        .filter((group) => group.enabled)
        .map((group) => group.name);
    },
    /** Provider adapters own this lease, and end it or abort lifetime on every exit path. */
    openSession(scope: McpScope, lifetime: AbortSignal) {
      if (!store.getMcpAgent(scope.threadId, scope.agentId)) throw new Error("Unknown MCP caller");
      const lease = server.credentials.issue(scope, lifetime);
      const stop = observations?.lease(scope.sessionId);
      let ended = false;
      const end = () => {
        if (ended) return;
        ended = true;
        lease.principal.signal.removeEventListener("abort", end);
        stop?.();
        lease.end();
      };
      lease.principal.signal.addEventListener("abort", end, { once: true });
      return { ...lease, end };
    },
    close: server.close,
  };
}
