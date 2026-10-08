import { z } from "zod";
import { McpServerInput } from "@ace/protocol";
import type { ProviderMcpControl } from "@ace/engine-api";
import type { OpenCodeClient } from "@opencode/client";

const catalog = z.object({
  data: z
    .array(
      z.object({
        name: z.string().max(256),
        status: z.object({ status: z.string() }),
      }),
    )
    .max(512),
});
/** Location-scoped native registrations; provider authentication stays in its own config. */
export function openCodeMcpControls(
  client: OpenCodeClient,
  directory: () => string,
): ProviderMcpControl {
  const location = () => ({ directory: directory() });
  const connect = (server: string) => client.mcp.connect({ server, location: location() });
  const disconnect = (server: string) => client.mcp.disconnect({ server, location: location() });
  return {
    async status() {
      return catalog
        .parse(await client.mcp.list({ location: location() }))
        .data.map((server) => ({ name: server.name, status: server.status.status }));
    },
    async add(name, input) {
      const server = McpServerInput.parse(input);
      await client.mcp.add({
        server: name,
        location: location(),
        config:
          server.transport === "http"
            ? { type: "remote", url: server.url }
            : { type: "local", command: [server.command, ...server.args] },
      });
      await connect(name);
    },
    async replace() {
      throw new Error("OpenCode does not support replacing live MCP servers");
    },
    async reconnect(name) {
      await disconnect(name);
      await connect(name);
    },
    enable: connect,
    disable: disconnect,
  };
}
