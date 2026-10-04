import { startProjects } from "./projects.ts";
import { startCursorAuth } from "./cursor-auth.ts";
import { startPreviewClient } from "./preview-client.ts";
import { startConductor } from "./conductor.ts";
import { startAutomations } from "./automations.ts";
import { startWorkspaceActions } from "./workspace-actions.ts";
import { startThreadOrganization } from "./thread-organization.ts";
import { startDevices } from "./devices.ts";
import { startThreadTransitions } from "./thread-transitions.ts";
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
import { startAgentControl } from "./agent-control.ts";
import { startPi } from "./pi.ts";
import { startEngine } from "./engine.ts";
import type { ServiceContext, Services } from "./types.ts";
import type { ServiceDefinition } from "./startup.ts";
/** Dependencies are explicit; optional integration failures do not disable the engine. */
export const serviceFactories: readonly ServiceDefinition[] = [
  { name: "screen", phase: "core", requires: [], after: [], start: startScreen },
  { name: "accounts", phase: "core", requires: [], after: [], start: startAccounts },
  { name: "commands", phase: "core", requires: ["accounts"], after: [], start: startCommands },
  { name: "files", phase: "core", requires: [], after: [], start: startFiles },
  { name: "devices", phase: "core", requires: [], after: ["screen", "files"], start: startDevices },
  { name: "relay", phase: "core", requires: ["files"], after: [], start: startRelayKeys },
  { name: "plugins", phase: "core", requires: [], after: [], start: startPlugins },
  { name: "settings", phase: "core", requires: [], after: [], start: startSettings },
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
  { name: "models", phase: "core", requires: [], after: [], start: startModels },
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
    requires: [],
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
  requireService(services.handler, "engine");
}
export type { ServiceContext };
