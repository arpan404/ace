import type { CursorHostSlots } from "@ace/adapter-cursor";
import type { DevicesService } from "@ace/devices";
import type { ScreenManager } from "@ace/screen";
import type { CursorAuthService } from "@ace/accounts";
import type { AccountService, AccountRegistry } from "@ace/accounts";
import type { bindCursorSdk } from "@ace/accounts";
import type { CommandLibrary } from "@ace/commands";
import type { FilesService } from "@ace/files";
import type { KeyPair } from "@ace/secure-channel";
import type { createLogger } from "@ace/diagnostics";
import type { BrowserService } from "@ace/browser";
import type { ContextService } from "@ace/context";
import type { SettingsService } from "@ace/settings";
import type { PluginService, preparePluginSession, launchPluginProcess } from "@ace/plugins";
import type { Provider } from "@ace/plugins";
import type { SpawnOptions } from "@ace/provider-kit/process";
import type { ModelCatalog } from "@ace/models";
import type { NotificationWorker } from "@ace/notify";
import type { Engine } from "../engine/index.ts";
import type { createDaemonReview } from "../review.ts";
import type { startDaemonMcp } from "../mcp.ts";
import type { DaemonHistory } from "../history.ts";
import type { createDaemonUsage } from "../usage.ts";
import type { Config } from "../config.ts";
import type { Store } from "../store.ts";
import type { CommandHandler } from "../commands.ts";
import type { startServer } from "../server.ts";
import type { DaemonOptions } from "./options.ts";
import type { Resources } from "./resources.ts";
export interface Services {
  rediscoverProviders?: () => Promise<void>;
  refreshModelInstances?: (provider: import("@ace/protocol").ProviderKind) => Promise<void>;
  providerInstalls?: import("../provider-install/sessions.ts").ProviderInstalls;
  providerLogin?: import("@ace/accounts").ProviderLoginSessions;
  onboarding?: import("../onboarding.ts").Onboarding;
  providerStatuses?: import("../provider-status.ts").ProviderStatuses;
  previewClient?: import("../preview-client.ts").PreviewClient;
  automations?: import("@ace/automations").AutomationService;
  activityReads?: import("../activity-reads.ts").ActivityReads;
  projects?: import("../projects.ts").Projects;
  workspaceActions?: import("../workspace-runtime.ts").WorkspaceRuntime;
  canReadThread?: NonNullable<import("../server-options.ts").ServerOptions["canReadThread"]>;
  agentControl?: {
    previews: import("../agent-control/owners.ts").AgentPreviews;
    delegations: import("../agent-control/delegations.ts").DelegationService;
    port: import("@ace/mcp-server").AgentControlPort;
  };
  transitions?: import("../engine/transitions.ts").TransitionIO;
  pi?: import("./pi.ts").PiService;
  screen?: ScreenManager;
  screenApprovals?: import("../screen-approvals.ts").ScreenApprovals;
  devices?: DevicesService;
  accounts?: AccountService;
  accountManagement?: import("../account-management.ts").AccountManagement;
  cursorAuth?: CursorAuthService;
  providerActivation?: Promise<void>;
  accountRegistry?: AccountRegistry;
  commands?: CommandLibrary;
  files?: FilesService;
  threadFiles?: import("../files-workspaces.ts").FilesWorkspaces;
  relay?: { url: string; keys: KeyPair };
  handler: CommandHandler;
  agentRegistry?: import("@ace/agent-registry").AgentRegistry;
  engine?: Engine;
  cursorHosts?: CursorHostSlots;
  cursorAccounts?: ReturnType<typeof bindCursorSdk>;
  plugins: PluginService;
  preparePlugins(provider: Provider, root: string): ReturnType<typeof preparePluginSession>;
  launchPlugins(
    provider: Provider,
    root: string,
    options: SpawnOptions,
  ): ReturnType<typeof launchPluginProcess>;
  browser: BrowserService;
  browserApprovals?: import("../browser-approvals.ts").BrowserApprovals;
  browserOrigins?: import("../browser-origins.ts").BrowserOrigins;
  context: ContextService;
  settings: SettingsService;
  models: ModelCatalog;
  providerConfigurations: import("../provider-configurations.ts").ProviderConfigurationsState;
  /** Filesystem admission completes separately from lazy metadata discovery. */
  modelsReady?: Promise<void>;
  mcp: Awaited<ReturnType<typeof startDaemonMcp>>;
  notifications: NotificationWorker;
  review: ReturnType<typeof createDaemonReview>;
  historyAdapters?: import("../history-continuation.ts").HistoryAdapterPort;
  history?: DaemonHistory;
  usage: ReturnType<typeof createDaemonUsage>;
}
export interface ServiceContext {
  signal: AbortSignal;
  readiness?(read: () => { state: "starting" | "ready" | "degraded"; error?: string }): void;
  config: Config;
  options: DaemonOptions;
  store: Store;
  now(): number;
  id(): string;
  log: ReturnType<typeof createLogger>;
  resources: Resources;
  services: Partial<Services>;
  onListen: ((server: Awaited<ReturnType<typeof startServer>>) => void | Promise<void>)[];
}
