import { McpProviderSessions } from "./mcp-provider-sessions.ts";
import { randomUUID } from "node:crypto";
import { ItemId, type McpScope } from "@ace/protocol";
import {
  type StatusReader,
  ToolRegistry,
  nodeScheduler,
  registerBuiltins,
  startMcpServer,
  type Toolkit,
  type CallObserver,
  type AwarenessPort,
  aceToolAction,
} from "@ace/mcp-server";
import type { Store } from "./store.ts";

export async function startDaemonMcp(
  store: Store,
  toolkits: readonly Toolkit[] = [],
  observations?: { observeCall: CallObserver; lease(sessionId: string): () => void },
  status?: StatusReader,
  awareness?: AwarenessPort,
) {
  const registry = new ToolRegistry({
    scheduler: nodeScheduler,
    ...(observations ? { observeCall: observations.observeCall } : {}),
  });
  registerBuiltins(
    registry,
    {
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
    },
  );
  for (const toolkit of toolkits) toolkit.register(registry);
  const server = await startMcpServer({
    maxBodyBytes: 2 * 1024 * 1024,
    registry,
    ...(awareness ? { awareness } : {}),
    status:
      status ??
      ((caller) => ({
        access: store.getThread(caller.threadId)?.permission?.effective ?? null,
      })),
  });
  return {
    url: server.url,
    toolNames: () => ["ace_status", ...registry.names()],
    toolsChanged: server.toolsChanged,
    /** This session's failed ace calls, for diagnostics. */
    failures: (sessionId: string) => server.awareness?.recentFailures(sessionId) ?? [],
    // ace_status lives in its own registry; its static catalog entry still attributes it.
    action: (name: string, input: unknown) =>
      registry.action(name, input) ?? aceToolAction(name, input),
    providers: new McpProviderSessions(),
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
      return {
        ...lease,
        end,
        /** Brief and groups for the provider's native instructions (P1). */
        session: () => server.awareness?.guidance(lease.principal) ?? {},
        /** The digest since this session's last ace call, for turn-start hooks. */
        changes: () => server.awareness?.changes(lease.principal),
      };
    },
    close: server.close,
  };
}
