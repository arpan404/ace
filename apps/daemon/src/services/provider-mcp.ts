import type { ProviderAdapter, ProviderSession } from "@ace/engine-api";
import type { ServiceContext } from "./types.ts";

/** Every provider receives a session-scoped ace MCP connection. Adapters choose native encoding. */
export function withDaemonMcp(
  context: Pick<ServiceContext, "services" | "store" | "id">,
  adapter: ProviderAdapter,
): ProviderAdapter {
  if (adapter.provider === "claude") return adapter; // Claude's SDK controls own its existing lease.
  return {
    ...adapter,
    async openSession(ctx) {
      const mcp = context.services.mcp;
      const agentId = context.store.getThread(ctx.threadId)?.rootAgentId;
      if (!mcp || !agentId) throw new Error("Provider MCP scope unavailable");
      const lease = mcp.openSession(
        {
          sessionId: context.id(),
          threadId: ctx.threadId,
          agentId,
          capabilities: ["agents", "notify", "browser"],
        },
        ctx.signal,
      );
      try {
        const session = await adapter.openSession({
          ...ctx,
          aceMcp: { url: mcp.url, bearer: lease.bearer },
          onExit(exit) {
            lease.end();
            ctx.onExit(exit);
          },
        });
        // Preserve prototype methods as well as account/provider metadata.
        const bound: ProviderSession = {
          ...(session.mcp ? { mcp: session.mcp } : {}),
          ...(session.instanceId ? { instanceId: session.instanceId } : {}),
          get nativeSessionId() {
            return session.nativeSessionId;
          },
          send: (input, delivery) => session.send(input, delivery),
          interrupt: (target) => session.interrupt(target),
          resolve: (key, answer) => session.resolve(key, answer),
          stopTask: (key) => session.stopTask(key),
          async close(reason) {
            try {
              await session.close(reason);
            } finally {
              lease.end();
            }
          },
        };
        return bound;
      } catch (error) {
        lease.end();
        throw error;
      }
    },
  };
}
