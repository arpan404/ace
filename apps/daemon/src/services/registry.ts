import { ClientMessage, BrowserClientMessage } from "@ace/protocol";
import { PluginClientMessage } from "@ace/protocol/plugins";
import { createPluginsSession } from "./plugins.ts";
import { createBrowserSession } from "./browser.ts";
import { createContextSession } from "./context.ts";
import { createSettingsSession } from "./settings.ts";
import { createHistorySession } from "./history.ts";
import { createUsageSession } from "./usage.ts";
import { createModelsSession } from "./models.ts";
import { createReviewSession } from "./review.ts";
import { createEngineSession } from "./engine.ts";
import { createDiagnosticsSession } from "./diagnostics.ts";
import type { SocketContext, SocketMessage } from "./socket.ts";
export const socketServiceFactories = [
  createPluginsSession,
  createBrowserSession,
  createContextSession,
  createSettingsSession,
  createHistorySession,
  createUsageSession,
  createModelsSession,
  createReviewSession,
  createEngineSession,
  createDiagnosticsSession,
];
export function createServiceSessions(context: SocketContext) {
  return socketServiceFactories.map((factory) => factory(context));
}
export function parseSocketMessage(input: unknown): SocketMessage {
  for (const schema of [ClientMessage, PluginClientMessage, BrowserClientMessage]) {
    const result = schema.safeParse(input);
    if (result.success) return result.data;
  }
  throw new Error("Message does not match the protocol");
}
