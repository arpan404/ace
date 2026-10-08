import type { ClientApi } from "@ace/client";
import { ThreadId, McpSources, type McpServerInput } from "@ace/protocol";

export function mcpSource(client: ClientApi, id: string) {
  const threadId = ThreadId.parse(id);
  return {
    async read(signal?: AbortSignal) {
      return McpSources.parse(
        (await client.request({ type: "mcp.sources", threadId }, signal ? { signal } : undefined))
          .result,
      );
    },
    async control(type: "mcp.reconnect" | "mcp.enable" | "mcp.disable", name: string) {
      await client.request({ type, threadId, name });
    },
    async add(name: string, server: McpServerInput) {
      await client.request({ type: "mcp.add", threadId, name, server });
    },
  };
}
