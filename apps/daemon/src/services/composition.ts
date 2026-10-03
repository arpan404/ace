import { startPreviewClient } from "./preview-client.ts";
import { startConductor } from "./conductor.ts";
import { startAutomations } from "./automations.ts";
import { startWorkspaceActions } from "./workspace-actions.ts";
import { startThreadOrganization } from "./thread-organization.ts";
import { startAgentRegistry } from "./agent-registry.ts";
import { startScreen } from "./screen.ts";
import { startAccounts } from "./accounts.ts";
import { startCommands } from "./commands.ts";
import { startFiles } from "./files.ts";
import { startRelayKeys } from "./relay.ts";
import { startPlugins } from "./plugins.ts";
import { startBrowser } from "./browser.ts";
import { startContext } from "./context.ts";
import { startSettings } from "./settings.ts";
import { startReview } from "./review.ts";
import { startHistory } from "./history.ts";
import { startUsage } from "./usage.ts";
import { startModels } from "./models.ts";
import { startMcp } from "./mcp.ts";
import { startNotifications } from "./notifications.ts";
import { startEngine } from "./engine.ts";
import type { ServiceContext, Services } from "./types.ts";
/** Ordered composition: provider sessions are admitted only after their services open. */
export const serviceFactories = [
  startScreen,
  startAccounts,
  startCommands,
  startFiles,
  startRelayKeys,
  startPlugins,
  startBrowser,
  startContext,
  startSettings,
  startReview,
  startHistory,
  startUsage,
  startModels,
  startMcp,
  startNotifications,
  startAgentRegistry,
  startPreviewClient,
  startWorkspaceActions,
  startEngine,
  startThreadOrganization,
  startAutomations,
  startConductor,
];
export function readyServices(services: Partial<Services>): Services {
  const {
    handler,
    plugins,
    preparePlugins,
    launchPlugins,
    browser,
    context,
    settings,
    models,
    mcp,
    notifications,
    review,
    usage,
  } = services;
  if (
    !handler ||
    !plugins ||
    !preparePlugins ||
    !launchPlugins ||
    !browser ||
    !context ||
    !settings ||
    !models ||
    !mcp ||
    !notifications ||
    !review ||
    !usage
  )
    throw new Error("Incomplete daemon service composition");
  return {
    handler,
    plugins,
    preparePlugins,
    launchPlugins,
    browser,
    context,
    settings,
    models,
    mcp,
    notifications,
    review,
    usage,
    ...(services.agentRegistry ? { agentRegistry: services.agentRegistry } : {}),
    ...(services.workspaceActions ? { workspaceActions: services.workspaceActions } : {}),
    ...(services.canReadThread ? { canReadThread: services.canReadThread } : {}),
    ...(services.previewClient ? { previewClient: services.previewClient } : {}),
    ...(services.conductor ? { conductor: services.conductor } : {}),
    ...(services.automations ? { automations: services.automations } : {}),
    ...(services.screen ? { screen: services.screen } : {}),
    ...(services.accounts ? { accounts: services.accounts } : {}),
    ...(services.commands ? { commands: services.commands } : {}),
    ...(services.files ? { files: services.files } : {}),
    ...(services.relay ? { relay: services.relay } : {}),
    ...(services.engine ? { engine: services.engine } : {}),
    ...(services.history ? { history: services.history } : {}),
  };
}
export type { ServiceContext };
