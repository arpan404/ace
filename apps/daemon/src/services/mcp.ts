import { browserToolkit } from "../browser-toolkit.ts";
import { screenToolkit } from "@ace/screen";
import { handoffToolkit } from "./handoff-tools.ts";
import { startDaemonMcp } from "../mcp.ts";
import type { ServiceContext } from "./types.ts";
export async function startMcp(context: ServiceContext): Promise<void> {
  const { options, store, resources, services } = context;

  const mcp = await startDaemonMcp(store, [
    handoffToolkit(store),
    ...(options.toolkits ?? []),
    ...(services.browser ? [browserToolkit(services.browser, store)] : []),
    ...(services.screen ? [screenToolkit(services.screen)] : []),
  ]);
  resources.own(() => mcp.close());
  services.mcp = mcp;
}

import type { SocketContext, SocketService } from "./socket.ts";
export function createMcpSession(context: SocketContext): SocketService {
  const { options, authorize, connected, send, fail, canReadThread } = context;
  return {
    async handle(message) {
      if (
        message.type !== "mcp.status" &&
        message.type !== "mcp.replace" &&
        message.type !== "mcp.reconnect" &&
        message.type !== "mcp.enable" &&
        message.type !== "mcp.disable"
      )
        return false;
      if (
        !authorize(message.type === "mcp.status" ? "read" : "operate") ||
        !canReadThread(message.threadId)
      ) {
        fail("forbidden", "Thread MCP scope required");
        return true;
      }
      try {
        const controls = options.mcp?.providers.require(message.threadId);
        if (!controls) throw new Error("Provider MCP session unavailable");
        let result: unknown;
        switch (message.type) {
          case "mcp.status":
            result = await controls.status();
            break;
          case "mcp.replace":
            result = await controls.replace(message.servers);
            break;
          case "mcp.reconnect":
            result = await controls.reconnect(message.name);
            break;
          case "mcp.enable":
            result = await controls.enable(message.name);
            break;
          case "mcp.disable":
            result = await controls.disable(message.name);
            break;
        }
        if (connected())
          send({
            type: "mcp.result",
            threadId: message.threadId,
            requestId: message.requestId,
            result: result ?? null,
          });
      } catch (error) {
        fail(
          "mcp_failed",
          error instanceof Error ? error.message : "Provider MCP control failed",
          false,
          { requestId: message.requestId },
        );
      }
      return true;
    },
  };
}
