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
  externalMcp?: import("../external-mcp/server.ts").ExternalMcp;
  storage?: import("../storage/service.ts").StorageService;
  sourceControl?: import("../source-control.ts").SourceControl;
  antigravityAuth?: "logged_in" | "logged_out";
  rediscoverProviders?: () => Promise<void>;
  refreshModelInstances?: (provider: import("@ace/protocol").ProviderKind) => Promise<void>;
  providerInstalls?: import("../provider-install/sessions.ts").ProviderInstalls;
  providerLogin?: import("@ace/accounts").ProviderLoginSessions;
  onboarding?: import("../onboarding.ts").Onboarding;
  providerStatuses?: import("../provider-status.ts").ProviderStatuses;
  utility?: import("./utility.ts").UtilityService;
  previewClient?: import("../preview-client.ts").PreviewClient;
  previewSuggestions?: import("../preview-suggestions/tracker.ts").SuggestionTracker;
  automations?: import("@ace/automations").AutomationService;
  activityReads?: import("../activity-reads.ts").ActivityReads;
  icons?: import("../icons/icon-service.ts").IconService;
  projects?: import("../projects.ts").Projects;
  workspaceActions?: import("../workspace-runtime.ts").WorkspaceRuntime;
  canReadThread?: NonNullable<import("../server-options.ts").ServerOptions["canReadThread"]>;
  agentControl?: {
    publications: import("../agent-control/remote-publication.ts").RemotePublications;
    returns: import("../agent-control/remote-return.ts").RemoteReturns;
    remote: import("../agent-control/remote.ts").RemoteDelegations;
    previews: import("../agent-control/owners.ts").AgentPreviews;
    delegations: import("../agent-control/delegations.ts").DelegationService;
    port: import("@ace/mcp-server").AgentControlPort;
  };
  /** Agent calls from other paired machines, answered here (ADR 0078). */
  machineCalls?: import("../machines/target.ts").MachineTarget;
  /** Agents here using other paired machines (ADR 0078). */
  machines?: {
    caller: import("../machines/caller.ts").MachineCaller;
    children: import("../machines/children.ts").MachineChildren;
  };
  transitions?: import("../engine/transitions.ts").TransitionIO;
  pi?: import("./pi.ts").PiService;
  screen?: ScreenManager;
  /** `ace_ask` questions waiting on the person. */
  asks?: import("../asks.ts").Asks;
  devices?: DevicesService;
  accounts?: AccountService;
  accountManagement?: import("../account-management.ts").AccountManagement;
  cursorAuth?: CursorAuthService;
  providerActivation?: Promise<void>;
  accountRegistry?: AccountRegistry;
  promptFiles?: import("@ace/commands").PromptFiles;
  commands?: CommandLibrary;
  files?: FilesService;
  supportFiles?: FilesService;
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
  /** Refuses answers to a private-takeover hold; only handback releases it. */
  browserPrivateAnswers?: (
    command: import("@ace/protocol").Command,
  ) => import("@ace/protocol").CommandResult | undefined;
  context: ContextService;
  settings: SettingsService;
  models: ModelCatalog;
  providerConfigurations: import("../provider-configurations.ts").ProviderConfigurationsState;
  /** Filesystem admission completes separately from lazy metadata discovery. */
  modelsReady?: Promise<void>;
  mcp: Awaited<ReturnType<typeof startDaemonMcp>>;
  notifications: NotificationWorker;
  notificationPublicKey?: string;
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
