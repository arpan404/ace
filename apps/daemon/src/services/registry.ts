import { createThreadTransitionsSession } from "./thread-transitions.ts";
import { createPiSocketSession } from "./pi.ts";
import { createAgentRegistrySession } from "./agent-registry.ts";
import { createScreenSession } from "./screen.ts";
import { Simulators } from "@ace/screen";
import { createSearchSession } from "./search.ts";
import { createAccountsSession } from "./accounts.ts";
import { createCommandsSession } from "./commands.ts";
import { createFilesSession } from "./files.ts";
import { ClientMessage, BrowserClientMessage } from "@ace/protocol";
import { PluginClientMessage } from "@ace/protocol/plugins";
import { createNotificationsSession } from "./notifications.ts";
import { createPluginsSession } from "./plugins.ts";
import { createBrowserSession } from "./browser.ts";
import { createContextSession } from "./context.ts";
import { createSettingsSession } from "./settings.ts";
import { createHistorySession } from "./history.ts";
import { createMcpSession } from "./mcp.ts";
import { createUsageSession } from "./usage.ts";
import { createModelsSession } from "./models.ts";
import { createReviewSession } from "./review.ts";
import { createEngineSession } from "./engine.ts";
import { createDiagnosticsSession } from "./diagnostics.ts";
import type { SocketContext, SocketMessage } from "./socket.ts";
export const socketServiceFactories = [
  createPiSocketSession,
  createSearchSession,
  createAccountsSession,
  createCommandsSession,
  createFilesSession,
  createNotificationsSession,
  createPluginsSession,
  createBrowserSession,
  createContextSession,
  createSettingsSession,
  createHistorySession,
  createUsageSession,
  createMcpSession,
  createModelsSession,
  createAgentRegistrySession,
  createReviewSession,
  createThreadTransitionsSession,
  createEngineSession,
  createDiagnosticsSession,
];
export function createSocketRegistry() {
  const simulators = new Simulators(process.platform);
  return (context: SocketContext) => [
    ...socketServiceFactories.map((factory) => factory(context)),
    createScreenSession(context, simulators),
  ];
}
export function parseSocketMessage(input: unknown): SocketMessage {
  for (const schema of [ClientMessage, PluginClientMessage, BrowserClientMessage]) {
    const result = schema.safeParse(input);
    if (result.success) return result.data;
  }
  throw new Error("Message does not match the protocol");
}
