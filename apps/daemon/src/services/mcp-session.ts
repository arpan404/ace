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
  const lease = options.mcp.openSession(
    {
      sessionId: options.id(),
      threadId: context.threadId,
      agentId,
      capabilities: options.capabilities,
    },
    context.signal,
  );
  lease.principal.signal.addEventListener(
    "abort",
    () => options.onEnd?.(context.threadId, agentId),
    { once: true },
  );
  try {
    const session = await adapter.openSession({
      ...context,
      aceMcp: { url: options.mcp.url, bearer: lease.bearer },
      onExit(exit) {
        lease.end();
        context.onExit(exit);
      },
    });
    return {
      get nativeSessionId() {
        return session.nativeSessionId;
      },
      ...(session.instanceId ? { instanceId: session.instanceId } : {}),
      send: (input, delivery) => session.send(input, delivery),
      interrupt: (target) => session.interrupt(target),
      resolve: (interaction, resolution) => session.resolve(interaction, resolution),
      stopTask: (task) => session.stopTask(task),
      async close(reason) {
        lease.end();
        await session.close(reason);
      },
    };
  } catch (error) {
    lease.end();
    throw error;
  }
}
