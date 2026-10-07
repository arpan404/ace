import { startProviderInstalls } from "./provider-install.ts";
import { startProviderLogin } from "./provider-login.ts";
import { startProviderStatuses } from "./provider-status.ts";
import { startProjects } from "./projects.ts";
import { startCursorAuth } from "./cursor-auth.ts";
import { startPreviewClient } from "./preview-client.ts";
import { startConductor } from "./conductor.ts";
import { startAutomations } from "./automations.ts";
import { startActivityReads } from "./activity-reads.ts";
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
import { startBrowser } from "./browser.ts";
import { startContext } from "./context.ts";
import { startSettings } from "./settings.ts";
import { startReview } from "./review.ts";
import { startHistory } from "./history.ts";
import { startUsage } from "./usage.ts";
import { startModels } from "./models.ts";
import { startMcp } from "./mcp.ts";
import { startNotifications } from "./notifications.ts";
import { startAgentControl } from "./agent-control.ts";
import { startPi } from "./pi.ts";
import { startEngine } from "./engine.ts";
import type { ServiceContext, Services } from "./types.ts";
import type { ServiceDefinition } from "./startup.ts";
/** Dependencies are explicit; optional integration failures do not disable the engine. */
export const serviceFactories: readonly ServiceDefinition[] = [
  { name: "screen", phase: "core", requires: [], after: [], start: startScreen },
  { name: "settings", phase: "core", requires: [], after: [], start: startSettings },
  { name: "accounts", phase: "core", requires: [], after: [], start: startAccounts },
  {
    name: "providerStatuses",
    phase: "core",
    requires: [],
    after: ["accounts", "settings"],
    start: startProviderStatuses,
  },
  { name: "commands", phase: "core", requires: ["accounts"], after: [], start: startCommands },
  { name: "files", phase: "core", requires: [], after: [], start: startFiles },
  { name: "devices", phase: "core", requires: [], after: ["screen", "files"], start: startDevices },
  { name: "relay", phase: "core", requires: ["files"], after: [], start: startRelayKeys },
  { name: "plugins", phase: "core", requires: [], after: [], start: startPlugins },
  { name: "activityReads", phase: "core", requires: [], after: [], start: startActivityReads },
  { name: "browser", phase: "core", requires: [], after: ["settings"], start: startBrowser },
  {
    name: "workspaceActions",
    phase: "core",
    requires: [],
    after: ["files"],
    start: startWorkspaceActions,
  },
  {
    name: "projects",
    phase: "core",
    requires: ["settings"],
    after: ["workspaceActions"],
    start: startProjects,
  },
  {
    name: "models",
    phase: "core",
    requires: ["accounts"],
    after: ["settings", "accounts"],
    start: startModels,
  },
  {
    name: "mcp",
    phase: "core",
    requires: [],
    after: ["screen", "browser", "devices"],
    start: startMcp,
  },
  {
    name: "transitions",
    phase: "core",
    requires: [],
    after: ["accounts"],
    start: startThreadTransitions,
  },
  { name: "pi", phase: "core", requires: [], after: ["mcp"], start: startPi },
  { name: "agentRegistry", phase: "core", requires: [], after: [], start: startAgentRegistry },
  {
    name: "engine",
    phase: "core",
    requires: ["accounts"],
    after: [
      "accounts",
      "plugins",
      "settings",
      "models",
      "mcp",
      "pi",
      "agentRegistry",
      "transitions",
      "workspaceActions",
    ],
    start: startEngine,
  },
  {
    name: "cursorAuth",
    phase: "listener",
    requires: ["engine", "accounts"],
    after: [],
    start: startCursorAuth,
  },
  {
    name: "accountManagement",
    phase: "listener",
    requires: ["accounts"],
    after: ["engine", "models", "cursorAuth"],
    start: startAccountManagement,
  },
  {
    name: "providerLogin",
    phase: "listener",
    requires: ["accounts"],
    after: ["models", "providerStatuses", "accountManagement", "cursorAuth"],
    start: startProviderLogin,
  },
  {
    name: "providerInstalls",
    phase: "listener",
    requires: [],
    after: ["models", "providerStatuses"],
    start: startProviderInstalls,
  },
  { name: "context", phase: "listener", requires: [], after: [], start: startContext },
  { name: "review", phase: "listener", requires: [], after: [], start: startReview },
  { name: "history", phase: "listener", requires: [], after: [], start: startHistory },
  { name: "usage", phase: "listener", requires: [], after: [], start: startUsage },
  { name: "notifications", phase: "listener", requires: [], after: [], start: startNotifications },
  {
    name: "agentControl",
    phase: "listener",
    requires: ["engine"],
    after: ["accounts", "context", "notifications"],
    start: startAgentControl,
  },
  { name: "previewClient", phase: "listener", requires: [], after: [], start: startPreviewClient },
  {
    name: "threadOrganization",
    phase: "listener",
    requires: [],
    after: ["engine", "settings", "workspaceActions"],
    start: startThreadOrganization,
  },
  {
    name: "automations",
    phase: "listener",
    requires: ["engine", "settings"],
    after: ["context", "agentControl", "workspaceActions"],
    start: startAutomations,
  },
  {
    name: "conductor",
    phase: "listener",
    // agentControl is a listener-phase service that is still "starting" until the listener
    // opens, so it can't be a hard dependency here; startConductor fails without it instead.
    requires: ["engine"],
    after: ["accounts", "notifications", "workspaceActions", "agentControl"],
    start: startConductor,
  },
];
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
  services.browserOrigins?.recover();
  services.screenApprovals?.recover();
  services.browserApprovals?.recover();
  services.handler = {
    handle: (command, store) =>
      services.screenApprovals?.resolve(command) ??
      services.browserApprovals?.resolve(command) ??
      services.browserOrigins?.resolve(command) ??
      handler.handle(command, store),
  };
}
export type { ServiceContext };
