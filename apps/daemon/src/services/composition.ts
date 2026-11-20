import { startStorage } from "./storage.ts";
import { startSourceControl } from "./source-control.ts";
import { startProviderInstalls } from "./provider-install.ts";
import { startProviderLogin } from "./provider-login.ts";
import { startProviderStatuses } from "./provider-status.ts";
import { startProjects } from "./projects.ts";
import { startCursorAuth } from "./cursor-auth.ts";
import { startPreviewClient } from "./preview-client.ts";
import { startBackgroundPorts } from "./background-ports.ts";
import { startAutomations } from "./automations.ts";
import { startSidebarPlacement } from "./sidebar-placement.ts";
import { startActivityReads } from "./activity-reads.ts";
import { startVerify } from "./verify.ts";
import { startIcons } from "./icons.ts";
import { startWorkspaceActions } from "./workspace-actions.ts";
import { startThreadOrganization } from "./thread-organization.ts";
import { startDevices } from "./devices.ts";
import { startThreadTransitions } from "./thread-transitions.ts";
import { startAgentRegistry } from "./agent-registry.ts";
import { startScreen } from "./screen.ts";
import { startAccounts, startAccountManagement } from "./accounts.ts";
import { startCommands } from "./commands.ts";
import { startFiles } from "./files.ts";
import { startRelayKeys } from "./relay.ts";
import { startPlugins } from "./plugins.ts";
import { startSuits } from "./suits.ts";
import { startMarketplace } from "./marketplace.ts";
import { startBrowser } from "./browser.ts";
import { startBrowsing } from "./browsing.ts";
import { startUserBrowser } from "./user-browser.ts";
import { startContext } from "./context.ts";
import { startSettings } from "./settings.ts";
import { startReview } from "./review.ts";
import { startHistory } from "./history.ts";
import { startUsage } from "./usage.ts";
import { startModels } from "./models.ts";
import { startMcp } from "./mcp.ts";
import { startNotifications } from "./notifications.ts";
import { startPi } from "./pi.ts";
import { startEngine } from "./engine.ts";
import { startUtility } from "./utility.ts";
import type { ServiceContext, Services } from "./types.ts";
import { loadOnStart, type ServiceDefinition } from "./startup.ts";
import { serviceOrder, type ServiceName } from "./service-order.ts";

/** Each service's start, by its name in `serviceOrder` (`service-order.ts`). */
const starts: Record<ServiceName, ServiceDefinition["start"]> = {
  screen: startScreen,
  settings: startSettings,
  sourceControl: startSourceControl,
  accounts: startAccounts,
  providerStatuses: startProviderStatuses,
  commands: startCommands,
  files: startFiles,
  devices: startDevices,
  relay: startRelayKeys,
  plugins: startPlugins,
  suits: startSuits,
  marketplace: startMarketplace,
  activityReads: startActivityReads,
  sidebarPlacement: startSidebarPlacement,
  icons: startIcons,
  userBrowser: startUserBrowser,
  browser: startBrowser,
  browsing: startBrowsing,
  workspaceActions: startWorkspaceActions,
  verify: startVerify,
  projects: startProjects,
  models: startModels,
  utility: startUtility,
  mcp: startMcp,
  transitions: startThreadTransitions,
  pi: startPi,
  agentRegistry: startAgentRegistry,
  engine: startEngine,
  cursorAuth: startCursorAuth,
  accountManagement: startAccountManagement,
  providerLogin: startProviderLogin,
  providerInstalls: startProviderInstalls,
  context: startContext,
  review: startReview,
  history: startHistory,
  usage: startUsage,
  notifications: startNotifications,
  agentControl: loadOnStart(() => import("./agent-control.ts"), "startAgentControl"),
  machines: loadOnStart(() => import("./machines.ts"), "startMachines"),
  transfers: loadOnStart(() => import("../transfers/service.ts"), "startTransfers"),
  parcels: loadOnStart(() => import("../parcels/service.ts"), "startParcels"),
  externalMcp: loadOnStart(() => import("./external-mcp.ts"), "startExternalMcp"),
  spade: loadOnStart(() => import("./spade.ts"), "startSpade"),
  threadAddress: loadOnStart(() => import("./thread-address.ts"), "startThreadAddress"),
  previewClient: startPreviewClient,
  backgroundPorts: startBackgroundPorts,
  threadOrganization: startThreadOrganization,
  automations: startAutomations,
  storage: startStorage,
};
export const serviceFactories: readonly ServiceDefinition[] = serviceOrder.map((entry) =>
  Object.assign({}, entry, { start: starts[entry.name] }),
);
/** Public daemon access fails explicitly when a feature could not be initialized. */
export function requireService<T>(service: T | undefined, name: string): T {
  if (service === undefined) throw new Error(`Service ${name} is degraded`);
  return service;
}
/** Keep the command port required while optional features publish into the live registry. */
export function readyServices(
  services: Partial<Services>,
): asserts services is Partial<Services> & Pick<Services, "handler"> {
  const handler = requireService(services.handler, "engine");
  services.handler = {
    handle: (command, store) => {
      // Stop in a thread also stops what its bots and clubs are answering (ADR 0194).
      if (command.payload.type === "thread.interrupt")
        void services.threadAsks?.stopThread(command.payload.threadId);
      return (
        services.asks?.resolve(command) ??
        services.browserHelp?.resolve(command) ??
        services.marketAgent?.requests.resolve(command) ??
        handler.handle(command, store)
      );
    },
  };
}
export type { ServiceContext };
