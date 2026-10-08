import type { ClientMessage, McpSources, ServerMessage } from "@ace/protocol";

/** Native-server fixture shares one catalog across connections, like the provider runtime. */
export class FakeMcpWire {
  readonly servers = new Map<string, McpSources["servers"]>();
  handle(message: ClientMessage, send: (message: ServerMessage) => void): boolean {
    if (
      message.type !== "mcp.sources" &&
      message.type !== "mcp.status" &&
      message.type !== "mcp.add" &&
      message.type !== "mcp.replace" &&
      message.type !== "mcp.reconnect" &&
      message.type !== "mcp.enable" &&
      message.type !== "mcp.disable"
    )
      return false;
    const catalog = this.servers.get(message.threadId) ?? [
      { name: "Project tools", status: "connected" },
      { name: "Documentation", status: "failed" },
    ];
    this.servers.set(message.threadId, catalog);
    let result: unknown = null;
    if (message.type === "mcp.sources")
      result = {
        groups: ["thread", "agents", "browser", "notify"],
        servers: catalog,
        live: true,
        canAdd: true,
        appliesNextTurn: false,
      };
    else if (message.type === "mcp.status") result = catalog;
    else if (message.type === "mcp.add") {
      if (catalog.some((server) => server.name === message.name)) {
        send({
          type: "error",
          requestId: message.requestId,
          code: "mcp_failed",
          message: "Name already used",
        });
        return true;
      }
      catalog.push({ name: message.name, status: "connected" });
    } else if (
      message.type === "mcp.enable" ||
      message.type === "mcp.disable" ||
      message.type === "mcp.reconnect"
    ) {
      const server = catalog.find((entry) => entry.name === message.name);
      if (server) server.status = message.type === "mcp.disable" ? "disabled" : "connected";
    }
    send({ type: "mcp.result", threadId: message.threadId, requestId: message.requestId, result });
    return true;
  }
}
