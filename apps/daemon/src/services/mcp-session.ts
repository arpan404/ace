import { acpInjection, acpStdioInjection } from "@ace/mcp-server";
import type { ProviderAdapter, ProviderSession, SessionContext } from "@ace/engine-api";
import type { McpCapability } from "@ace/protocol";
import type { Store } from "../store.ts";
import type { startDaemonMcp } from "../mcp.ts";

export async function bindMcpSession(
  adapter: ProviderAdapter,
  context: SessionContext,
  options: {
    mcp: Awaited<ReturnType<typeof startDaemonMcp>>;
    store: Pick<Store, "getThread">;
    id(): string;
    capabilities: McpCapability[];
    onEnd?(threadId: string, agentId: string): void;
  },
): Promise<ProviderSession> {
  const agentId = options.store.getThread(context.threadId)?.rootAgentId;
  if (!agentId) throw new Error("Cannot authorize MCP before the thread root exists");
  // Generic ACP already owns its negotiated HTTP/stdio lease. Keep that
  // connection and its configured servers instead of issuing a second one.
  const lease = context.mcp
    ? undefined
    : options.mcp.openSession(
        {
          sessionId: options.id(),
          threadId: context.threadId,
          agentId,
          capabilities: options.capabilities,
        },
        context.signal,
      );
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    lifetime.removeEventListener("abort", end);
    lease?.end();
    context.mcp?.end();
    options.onEnd?.(context.threadId, agentId);
  };
  const lifetime = lease?.principal.signal ?? context.signal;
  lifetime.addEventListener("abort", end, { once: true });
  const connection = lease ? { url: options.mcp.url, bearer: lease.bearer } : undefined;
  const nativeMcp =
    connection && ["acp", "cursor", "antigravity"].includes(adapter.provider)
      ? {
          httpServers: acpInjection(connection).mcpServers,
          stdioServers: acpStdioInjection(connection).mcpServers,
          secrets: [connection.bearer],
          end,
        }
      : context.mcp;
  try {
    const session = await adapter.openSession({
      ...context,
      ...(connection ? { aceMcp: connection } : {}),
      ...(nativeMcp ? { mcp: nativeMcp } : {}),
      onExit(exit) {
        end();
        context.onExit(exit);
      },
    });
    const setModel = session.setModel?.bind(session);
    const setMode = session.setMode?.bind(session);
    return {
      get nativeSessionId() {
        return session.nativeSessionId;
      },
      ...(session.instanceId ? { instanceId: session.instanceId } : {}),
      get effectiveCapabilities() {
        return session.effectiveCapabilities;
      },
      get acpSupport() {
        return session.acpSupport;
      },
      ...(session.mcp ? { mcp: session.mcp } : {}),
      ...(setModel ? { setModel } : {}),
      ...(setMode ? { setMode } : {}),
      send: (input, delivery) => session.send(input, delivery),
      interrupt: (target) => session.interrupt(target),
      resolve: (interaction, resolution) => session.resolve(interaction, resolution),
      stopTask: (task) => session.stopTask(task),
      async close(reason) {
        end();
        await session.close(reason);
      },
    };
  } catch (error) {
    end();
    throw error;
  }
}
