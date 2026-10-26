import { createCliControlSession } from "./cli-control.ts";
import { createStorageSession } from "./storage.ts";
import { createRepositoriesSession } from "./repositories.ts";
import { createSourceControlSession } from "./source-control.ts";
import { createPromptFilesSession } from "./prompt-files.ts";
import { createSkillLibrarySession } from "./skill-library.ts";
import { createProviderInstallsSession } from "./provider-install.ts";
import { createProviderLoginSession } from "./provider-login.ts";
import { createHostIdentitySession } from "./host-identity.ts";
import { createFleetSession } from "./fleet.ts";
import { createProviderStatusesSession } from "./provider-status.ts";
import { createProjectsSession } from "./projects.ts";
import { createTransfersSession } from "./transfers.ts";
import { createLongThreadSession } from "./long-thread.ts";
import { createPreviewClientSession } from "./preview-client.ts";
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
import {
  ClientMessage,
  BrowserClientMessage,
  BrowserBackendClientMessage,
  UserBrowserExtensionMessage,
} from "@ace/protocol";
import { PluginClientMessage } from "@ace/protocol/plugins";
import { createNotificationsSession } from "./notifications.ts";
import { createPluginsSession } from "./plugins.ts";
import { createBrowserSession } from "./browser.ts";
import { createBrowsingSession } from "./browsing.ts";
import { createComputerUsingSession } from "./computer-using.ts";
import { createUserBrowserSession } from "./user-browser.ts";
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
import { createVerifySession } from "./verify.ts";
import { createIconsSession } from "./icons.ts";
import type { SocketContext, SocketMessage } from "./socket.ts";
export const socketServiceFactories = [
  createCliControlSession,
  createStorageSession,
  createSourceControlSession,
  createRepositoriesSession,
  createHostIdentitySession,
  createFleetSession,
  createLongThreadSession,
  createPreviewClientSession,
  createAutomationsSession,
  createActivityReadsSession,
  createVerifySession,
  createIconsSession,
  createThreadOrganizationSession,
  createWorkspaceActionsSession,
  createProjectsSession,
  createTransfersSession,
  createTerminalSession,
  createRecoverySession,
  createDevicesSession,
  createPiSocketSession,

  createSearchSession,
  createAccountsSession,
  createCursorAuthSession,
  createCommandsSession,
  createPromptFilesSession,
  createSkillLibrarySession,
  // Before files: the files channel claims every binary message on a socket, and the desktop's
  // backend socket sends its video encoder's (ADR 0088).
  createBrowserSession,
  createFilesSession,
  createNotificationsSession,
  createPluginsSession,
  createBrowsingSession,
  createComputerUsingSession,
  createUserBrowserSession,
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
    UserBrowserExtensionMessage,
  ]) {
    const result = schema.safeParse(input);
    if (result.success) return result.data;
  }
  throw new Error("Message does not match the protocol");
}
