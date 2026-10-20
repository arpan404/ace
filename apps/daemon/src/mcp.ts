import { McpProviderSessions } from "./mcp-provider-sessions.ts";
import { timeOrderedIds } from "./time-ordered-id.ts";
import { ItemId, type McpScope } from "@ace/protocol";
import {
  type StatusReader,
  ToolRegistry,
  nodeScheduler,
  registerBuiltins,
  startMcpServer,
  type Toolkit,
  type CallObserver,
  type ToolFailureReporter,
  type AwarenessPort,
  type KnowledgePort,
  aceToolAction,
  aceToolDispatch,
  aceToolSearch,
  maxRequestBodyBytes,
} from "@ace/mcp-server";
import type { Store } from "./store.ts";

export async function startDaemonMcp(
  store: Store,
  toolkits: readonly Toolkit[] = [],
  observations?: { observeCall: CallObserver; lease(sessionId: string): () => void },
  status?: StatusReader,
  awareness?: AwarenessPort,
  knowledge?: Pick<KnowledgePort, "context">,
  reportFailure?: ToolFailureReporter,
) {
  // Intents and notices are database keys: time-ordered, they stay together in each index.
  const nextId = timeOrderedIds();
  const registry = new ToolRegistry({
    scheduler: nodeScheduler,
    ...(observations ? { observeCall: observations.observeCall } : {}),
    ...(reportFailure ? { reportFailure } : {}),
  });
  registerBuiltins(registry, {
    async notify(intent, signal) {
      const intentId = nextId();
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
              id: ItemId.parse(nextId()),
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
  });
  for (const toolkit of toolkits) toolkit.register(registry);
  const server = await startMcpServer({
    maxBodyBytes: maxRequestBodyBytes,
    registry,
    ...(awareness ? { awareness } : {}),
    ...(knowledge ? { knowledge } : {}),
    status:
      status ??
      ((caller) => ({
        access: store.getThread(caller.threadId)?.permission?.effective ?? null,
      })),
  });
  return {
    url: server.url,
    toolNames: () => ["context", aceToolSearch, aceToolDispatch, ...registry.names()],
    toolsChanged: server.toolsChanged,
    /** This session's failed ace calls, for diagnostics. */
    failures: (sessionId: string) => server.awareness?.recentFailures(sessionId) ?? [],
    // context lives in its own registry; its static catalog entry still attributes it.
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
