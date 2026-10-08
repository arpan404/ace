import type { ClientApi } from "@ace/client";
import { McpSources, type McpServerInput, type ProviderKind } from "@ace/protocol";

/** One provider's own MCP servers, read and changed through its most recent live session. */
export function providerMcpSource(client: ClientApi, provider: ProviderKind) {
  return {
    async read(signal?: AbortSignal) {
      const reply = await client.request(
        { type: "mcp.provider.sources", provider },
        signal ? { signal } : undefined,
      );
      return McpSources.parse(reply.result);
    },
    async control(
      type: "mcp.provider.reconnect" | "mcp.provider.enable" | "mcp.provider.disable",
      name: string,
    ) {
      await client.request({ type, provider, name });
    },
    async add(name: string, server: McpServerInput) {
      await client.request({ type: "mcp.provider.add", provider, name, server });
    },
  };
}
export type ProviderMcpSource = ReturnType<typeof providerMcpSource>;
