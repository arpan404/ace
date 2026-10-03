import { daemonMcpCapabilities } from "./mcp-capabilities.ts";
import type { ProviderAdapter } from "@ace/engine-api";
import { bindMcpSession } from "./mcp-session.ts";
import type { ServiceContext } from "./types.ts";

/** All providers share scoped authority and cleanup; adapters encode their native MCP config. */
export function withDaemonMcp(
  context: Pick<ServiceContext, "services" | "store" | "id">,
  adapter: ProviderAdapter,
): ProviderAdapter {
  return {
    ...adapter,
    openSession(session) {
      const mcp = context.services.mcp;
      if (!mcp) throw new Error("Provider MCP scope unavailable");
      return bindMcpSession(adapter, session, {
        mcp,
        store: context.store,
        id: context.id,
        capabilities: daemonMcpCapabilities(context.services),
        onEnd(threadId, agentId) {
          const owner = JSON.stringify([threadId, agentId]);
          context.services.devices?.disconnect(owner);
          context.services.screen?.releaseController(owner);
        },
      });
    },
  };
}
