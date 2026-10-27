import type { MaintenanceGate } from "@ace/service";
import type { CursorHostSlots } from "@ace/adapter-cursor";
import type { ComputerClient, ScreenManager } from "@ace/screen";
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
import type { NotificationAccess } from "../notifications.ts";
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
  /** Automations agents made from threads, for the person's own controls. */
  threadAutomations?: import("../agent-control/thread-automations.ts").ThreadAutomations;
  activityReads?: import("../activity-reads.ts").ActivityReads;
  /** Local checks and verified batch merges of pull requests (ADR 0094). */
  verify?: import("../verify/verify-service.ts").Verify;
  icons?: import("../icons/icon-service.ts").IconService;
  projects?: import("../projects.ts").Projects;
  /** Removed projects' browser profiles, forgotten in ace's Chrome and on the desktop. */
  browserProjects?: import("../browser-forget-projects.ts").BrowserProjectForget;
  workspaceActions?: import("../workspace-runtime.ts").WorkspaceRuntime;
  canReadThread?: NonNullable<import("../server-options.ts").ServerOptions["canReadThread"]>;
  agentControl?: {
    previews: import("../agent-control/owners.ts").AgentPreviews;
    delegations: import("../agent-control/delegations.ts").DelegationService;
    port: import("@ace/mcp-server").AgentControlPort;
  };
  /** Agent calls from other paired machines, answered here (ADR 0078). */
  machineCalls?: import("../machines/target.ts").MachineTarget;
  /** Projects and threads other machines send here (ADR 0101). */
  transferTarget?: import("../transfers/http.ts").TransferTarget;
  /** This machine's links to the person's other machines, made from Settings. */
  fleet?: import("../machines/fleet-links.ts").FleetLinks;
  /** Agents here using other paired machines (ADR 0078). */
  /** Projects and threads this machine sends to other machines (ADR 0101). */
  transfers?: import("../transfers/service.ts").DaemonTransfers;
  machines?: {
    caller: import("../machines/caller.ts").MachineCaller;
    children: import("../machines/children.ts").MachineChildren;
  };
  transitions?: import("../engine/transitions.ts").TransitionIO;
  pi?: import("./pi.ts").PiService;
  screen?: ScreenManager;
  /** The agent computer-use engine (macOS), beside the screen manager that streams to people. */
  computer?: ComputerClient;
  /** The locked use service owner (macOS); its service starts only when a gated call needs it. */
  lockedUseRuntime?: import("../locked-use-runtime.ts").LockedUseRuntime;
  /** `ask` questions waiting on the person. */
  asks?: import("../asks.ts").Asks;
  /** Threads whose browser an agent works in now (the task list's indicator). */
  browsing?: import("../browsing.ts").BrowsingThreads;
  /** Threads whose agent uses Mac apps now (the task list's indicator). */
  computerUsing?: import("../computer-using.ts").ComputerUsingThreads;
  /** `browser_request_help` requests waiting on the person. */
  browserHelp?: import("../browser-help.ts").BrowserHelp;
  devices?: import("../lazy-devices.ts").LazyDevices;
  accounts?: AccountService;
  accountManagement?: import("../account-management.ts").AccountManagement;
  cursorAuth?: CursorAuthService;
  providerActivation?: Promise<void>;
  accountRegistry?: AccountRegistry;
  promptFiles?: import("@ace/commands").PromptFiles;
  skillLibrary?: import("@ace/commands").SkillLibrary;
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
  /** "Use my Chrome" (ADR 0084): browsers connected through the ace extension. */
  userBrowser?: import("../user-browser.ts").UserBrowserService;
  /** Threads' browsers in the person's own Chrome, for agent calls with `browser: "user"`. */
  userBrowserSessions?: BrowserService;
  context: ContextService;
  settings: SettingsService;
  models: ModelCatalog;
  providerConfigurations: import("../provider-configurations.ts").ProviderConfigurationsState;
  /** The person's role settings, for runRole and new sessions' instructions. */
  roles: import("../role-settings.ts").RoleSettingsState;
  /** The person's limit on children one parent runs at once, read live at each launch. */
  childLimit: import("../child-limit-setting.ts").ChildLimitSetting;
  /** Filesystem admission completes separately from lazy metadata discovery. */
  modelsReady?: Promise<void>;
  mcp: Awaited<ReturnType<typeof startDaemonMcp>>;
  notifications: NotificationAccess;
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
  /**
   * The daemon's maintenance gate, created before any service so engine recovery honours it
   * from the start; the server shares the same gate.
   */
  maintenance?: MaintenanceGate;
  onListen: ((server: Awaited<ReturnType<typeof startServer>>) => void | Promise<void>)[];
}
