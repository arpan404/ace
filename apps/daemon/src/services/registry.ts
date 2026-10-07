import { createProviderInstallsSession } from "./provider-install.ts";
import { createProviderLoginSession } from "./provider-login.ts";
import { createHostIdentitySession } from "./host-identity.ts";
import { createProviderStatusesSession } from "./provider-status.ts";
import { createProjectsSession } from "./projects.ts";
import { createLongThreadSession } from "./long-thread.ts";
import { createPreviewClientSession } from "./preview-client.ts";
import { createConductorSession } from "./conductor.ts";
import { createAutomationsSession } from "./automations.ts";
import { createWorkspaceActionsSession } from "./workspace-actions.ts";
import { createTerminalSession } from "./terminal.ts";
import { createThreadOrganizationSession } from "./thread-organization.ts";
import { createRecoverySession } from "./recovery.ts";
import { createDevicesSession } from "./devices.ts";
import { createThreadTransitionsSession } from "./thread-transitions.ts";
import { createPiSocketSession } from "./pi.ts";

import { createAgentRegistrySession } from "./agent-registry.ts";
import { createScreenSession } from "./screen.ts";
import { Simulators } from "@ace/screen";
import { createSearchSession } from "./search.ts";
import { createCursorAuthSession } from "./cursor-auth.ts";
import { createAccountsSession } from "./accounts.ts";
import { createCommandsSession } from "./commands.ts";
import { createFilesSession } from "./files.ts";
import { ClientMessage, BrowserClientMessage, BrowserBackendClientMessage } from "@ace/protocol";
import { PluginClientMessage } from "@ace/protocol/plugins";
import { createNotificationsSession } from "./notifications.ts";
import { createPluginsSession } from "./plugins.ts";
import { createBrowserSession } from "./browser.ts";
import { createContextSession } from "./context.ts";
import { createSettingsSession } from "./settings.ts";
import { createPermissionsSession } from "./permissions.ts";
import { createHistorySession } from "./history.ts";
import { createMcpSession } from "./mcp.ts";
import { createUsageSession } from "./usage.ts";
import { createModelsSession } from "./models.ts";
import { createReviewSession } from "./review.ts";
import { createEngineSession } from "./engine.ts";
import { createDiagnosticsSession } from "./diagnostics.ts";
import { createActivityReadsSession } from "./activity-reads.ts";
import type { SocketContext, SocketMessage } from "./socket.ts";
export const socketServiceFactories = [
  createHostIdentitySession,
  createLongThreadSession,
  createPreviewClientSession,
  createConductorSession,
  createAutomationsSession,
  createActivityReadsSession,
  createThreadOrganizationSession,
  createWorkspaceActionsSession,
  createProjectsSession,
  createTerminalSession,
  createRecoverySession,
  createDevicesSession,
  createPiSocketSession,

  createSearchSession,
  createAccountsSession,
  createCursorAuthSession,
  createCommandsSession,
  createFilesSession,
  createNotificationsSession,
  createPluginsSession,
  createBrowserSession,
  createContextSession,
  createSettingsSession,
  createPermissionsSession,
  createHistorySession,
  createUsageSession,
  createMcpSession,
  createModelsSession,
  createProviderStatusesSession,
  createProviderLoginSession,
  createProviderInstallsSession,
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
  for (const schema of [
    ClientMessage,
    PluginClientMessage,
    BrowserClientMessage,
    BrowserBackendClientMessage,
  ]) {
    const result = schema.safeParse(input);
    if (result.success) return result.data;
  }
  throw new Error("Message does not match the protocol");
}
