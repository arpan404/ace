import { McpProviderSessions } from "./mcp-provider-sessions.ts";
import { randomUUID } from "node:crypto";
import { ItemId, type McpScope } from "@ace/protocol";
import {
  ToolRegistry,
  nodeScheduler,
  registerBuiltins,
  startMcpServer,
  type Toolkit,
} from "@ace/mcp-server";
import type { Store } from "./store.ts";

export async function startDaemonMcp(store: Store, toolkits: readonly Toolkit[] = []) {
  const registry = new ToolRegistry({ scheduler: nodeScheduler });
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
        const intentId = randomUUID();
        signal.throwIfAborted();
        store.enqueueMcpIntent(intentId, intent, [], Date.now());
        return { intentId };
      },
    },
  );
  for (const toolkit of toolkits) toolkit.register(registry);
  const server = await startMcpServer({ registry });
  return {
    url: server.url,
    providers: new McpProviderSessions(),
    /** Provider adapters own this lease, and end it or abort lifetime on every exit path. */
    openSession(scope: McpScope, lifetime: AbortSignal) {
      if (!store.getMcpAgent(scope.threadId, scope.agentId)) throw new Error("Unknown MCP caller");
      return server.credentials.issue(scope, lifetime);
    },
    close: server.close,
  };
}
