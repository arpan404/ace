import { McpProviderRequest } from "@ace/protocol";
import type { ClientMessage, McpSources, ServerMessage } from "@ace/protocol";

const types = new Set<string>(McpProviderRequest.options.map((option) => option.shape.type.value));
const isMcp = (message: ClientMessage): message is McpProviderRequest => types.has(message.type);

/**
 * Native-server fixture shares one catalog across connections, like the provider runtime: per
 * thread for thread-scoped requests, per provider for Settings' provider-wide ones. Providers in
 * `idle` have no live session.
 */
export class FakeMcpWire {
  readonly servers = new Map<string, McpSources["servers"]>();
  readonly idle = new Set<string>();
  handle(message: ClientMessage, send: (message: ServerMessage) => void): boolean {
    if (!isMcp(message)) return false;
    const mcp = message;
    const scope = "threadId" in mcp ? { threadId: mcp.threadId } : { provider: mcp.provider };
    const key = "threadId" in mcp ? mcp.threadId : mcp.provider;
    const live = !("provider" in mcp) || !this.idle.has(mcp.provider);
    const catalog = this.servers.get(key) ?? [
      { name: "Project tools", status: "connected" },
      { name: "vercel", status: "needs_auth" },
    ];
    this.servers.set(key, catalog);
    const fail = (text: string) =>
      send({ type: "error", requestId: mcp.requestId, code: "mcp_failed", message: text });
    let result: unknown = null;
    if (mcp.type === "mcp.sources" || mcp.type === "mcp.provider.sources")
      result = {
        groups: [],
        servers: live ? catalog : [],
        live,
        canAdd: live,
        appliesNextTurn: false,
      };
    else if (!live) {
      fail("Provider MCP session unavailable");
      return true;
    } else if (mcp.type === "mcp.status") result = catalog;
    else if (mcp.type === "mcp.add" || mcp.type === "mcp.provider.add") {
      if (catalog.some((server) => server.name === mcp.name)) {
        fail("Name already used");
        return true;
      }
      catalog.push({ name: mcp.name, status: "connected" });
    } else if (mcp.type !== "mcp.replace") {
      const server = catalog.find((entry) => entry.name === mcp.name);
      if (server) server.status = mcp.type.endsWith(".disable") ? "disabled" : "connected";
    }
    send({ type: "mcp.result", ...scope, requestId: mcp.requestId, result });
    return true;
  }
}
