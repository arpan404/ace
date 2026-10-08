import { z } from "zod";
import { codexDiscoveryApi } from "@ace/mcp-server";
import { McpServerInput } from "@ace/protocol";
import type { ProviderMcpControl } from "@ace/engine-api";

const entry = z.object({
  name: z.string().max(256),
  runtimeStatus: z.string().nullable().optional(),
});
const page = z.object({ data: z.array(entry).max(512) });
/** The app-server owns config.toml writes. ace sends no env, headers or credential operations. */
export function codexMcpControls(
  request: (method: string, params: unknown) => Promise<unknown>,
  threadId: string,
  signal: AbortSignal,
): ProviderMcpControl {
  const enabled = new Map<string, boolean>();
  const reload = async () => {
    await request("config/mcpServer/reload", {});
  };
  const write = async (name: string, suffix: string, value: unknown) => {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name))
      throw new Error("Manage this server name in Codex configuration");
    await request("config/value/write", {
      keyPath: `mcp_servers.${name}${suffix}`,
      value,
      mergeStrategy: "upsert",
    });
    await reload();
  };
  const toggle = async (name: string, on: boolean) => {
    await write(name, ".enabled", on);
    enabled.set(name, on);
  };
  return {
    appliesNextTurn: true,
    async status() {
      const api = codexDiscoveryApi({
        request: (method, params) => request(method, { ...params, threadId }),
      });
      return page.parse(await api.read(signal)).data.map((server) => ({
        name: server.name,
        status:
          enabled.get(server.name) === false ? "disabled" : (server.runtimeStatus ?? "unknown"),
      }));
    },
    async add(name, input) {
      const server = McpServerInput.parse(input);
      await write(
        name,
        "",
        server.transport === "http"
          ? { url: server.url }
          : { command: server.command, args: server.args },
      );
    },
    async replace() {
      throw new Error("Codex does not support replacing live MCP servers");
    },
    reconnect: reload,
    enable: (name) => toggle(name, true),
    disable: (name) => toggle(name, false),
  };
}
