import { acpInjection, acpStdioInjection } from "@ace/mcp-server";
import type { ExecutionSelection } from "@ace/protocol";
import type { ProviderAdapter, ProviderSession, SessionContext } from "@ace/engine-api";
import type { ServiceContext } from "./types.ts";

/** Every provider receives a session-scoped ace MCP connection. Adapters choose native encoding. */
export function withDaemonMcp(
  context: Pick<ServiceContext, "services" | "store" | "id">,
  adapter: ProviderAdapter,
): ProviderAdapter {
  // Claude SDK controls and Pi's extension own their MCP lease and lifetime.
  if (adapter.provider === "claude" || adapter.provider === "pi") return adapter;
  return {
    ...adapter,
    async openSession(ctx) {
      // Generic ACP already owns a negotiated HTTP/stdio lease from sessionContext.
      if (ctx.mcp) return adapter.openSession(ctx);
      const lease = sessionLease(context, ctx);
      const connection = { url: lease.url, bearer: lease.bearer };
      const acp = ["acp", "cursor", "antigravity"].includes(adapter.provider);
      try {
        const session = await adapter.openSession({
          ...ctx,
          aceMcp: ctx.aceMcp ?? connection,
          ...(acp
            ? {
                mcp: {
                  httpServers: acpInjection(connection).mcpServers,
                  stdioServers: acpStdioInjection(connection).mcpServers,
                  secrets: [lease.bearer],
                  end: lease.end,
                },
              }
            : {}),
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
          get effectiveCapabilities() {
            return session.effectiveCapabilities;
          },
          get acpSupport() {
            return session.acpSupport;
          },
          ...(session.setModel
            ? { setModel: (model: string) => session.setModel?.(model) ?? Promise.resolve() }
            : {}),
          ...(session.setMode
            ? { setMode: (mode: string) => session.setMode?.(mode) ?? Promise.resolve() }
            : {}),
          ...(session.configure
            ? {
                configure: (selection: ExecutionSelection) =>
                  session.configure?.(selection) ?? Promise.resolve(),
              }
            : {}),
          send: (input, delivery, commandId) => session.send(input, delivery, commandId),
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

function sessionLease(
  context: Pick<ServiceContext, "services" | "store" | "id">,
  ctx: SessionContext,
): { url: string; bearer: string; end(): void } {
  const inherited = ctx.aceMcp;
  if (inherited)
    return { url: inherited.url, bearer: inherited.bearer, end: () => inherited.end?.() };
  const mcp = context.services.mcp;
  const agentId = context.store.getThread(ctx.threadId)?.rootAgentId;
  if (!mcp || !agentId) throw new Error("Provider MCP scope unavailable");
  const lease = mcp.openSession(
    {
      sessionId: context.id(),
      threadId: ctx.threadId,
      agentId,
      capabilities: ["agents", "notify", "thread_control", "automations", "projects", "browser"],
    },
    ctx.signal,
  );
  return { url: mcp.url, bearer: lease.bearer, end: lease.end };
}
