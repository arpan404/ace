import { daemonMcpCapabilities } from "./mcp-capabilities.ts";
import type { ProviderAdapter } from "@ace/engine-api";
import { bindMcpSession } from "./mcp-session.ts";
import type { ServiceContext } from "./types.ts";

/** All providers share scoped authority and cleanup; adapters encode their native MCP config. */
export function withDaemonMcp(
  context: Pick<ServiceContext, "services" | "store" | "id">,
  adapter: ProviderAdapter,
): ProviderAdapter {
  if (adapter.backend === "cursor-sdk") return adapter;
  return {
    ...adapter,
    openSession(session) {
      const mcp = context.services.mcp;
      if (adapter.provider === "pi" && !mcp && !session.aceMcp && !session.mcp)
        return adapter.openSession(session);
      if (!mcp && !session.aceMcp && !session.mcp)
        throw new Error("Provider MCP scope unavailable");
      return bindMcpSession(adapter, session, {
        mcp,
        store: context.store,
        id: context.id,
        capabilities: daemonMcpCapabilities(context.services),
        onEnd(threadId, agentId) {
          releaseMcpControllers(context.services, threadId, agentId);
        },
      });
    },
  };
}

/** Shared by CLI leases and Cursor's independently owned SDK lease. */
export function releaseMcpControllers(
  services: ServiceContext["services"],
  threadId: string,
  agentId: string,
): void {
  const owner = JSON.stringify([threadId, agentId]);
  services.devices?.disconnect(owner);
  services.screen?.releaseController(owner);
}
