import type { MaintenanceGate } from "@ace/service";
import type { ScreenManager } from "@ace/screen";
import type { CursorAuthService } from "@ace/accounts";
import type { AccountService } from "@ace/accounts";
import type { CommandService } from "@ace/commands";
import type { FilesService } from "@ace/files";
import type { KeyPair } from "@ace/secure-channel";
import type { SettingsService } from "@ace/settings";
import type { DaemonPreviewOptions } from "./preview.ts";
import type { ReviewPort } from "./review.ts";
import type { DaemonHistory } from "./history.ts";
import type { ModelCatalogApi } from "@ace/models";
import type { DeliveryRuntime } from "./delivery-runtime.ts";
import type { UsageCommands } from "./usage.ts";
import type { NotificationWorker } from "@ace/notify";
import type { EntropySource } from "./credential-runtime.ts";
import type { TicketLimits } from "./ticket-pool.ts";
import type { IncomingMessage } from "node:http";
import type { RemoteListener } from "./network.ts";
import type { BrowserService } from "@ace/browser";
import type {
  DeviceId,
  DiagnosticsHealth,
  ThreadId,
  ContextRequest,
  ContextResult,
} from "@ace/protocol";
import type { PluginResponse } from "@ace/protocol/plugins";
import type { CommandHandler } from "./commands.ts";
import type { PressureOptions } from "./outbox.ts";
import type { Store } from "./store.ts";
export interface ServerOptions {
  externalMcp?: import("./external-mcp/server.ts").ExternalMcp;
  shutdown?: import("./shutdown-receipt.ts").ShutdownControl;
  /**
   * The daemon's lifetime, aborted as it begins to stop. A stop that comes while the server
   * starts gives up what waits on the network then (a relay registration nobody answers).
   */
  lifetime?: AbortSignal | undefined;
  cliControl?: ReturnType<typeof import("./services/cli-control.ts").cliControl>;
  storage?: import("./storage/service.ts").StorageService;
  sourceControl?: import("./source-control.ts").SourceControl;
  agentControl?: import("./services/types.ts").Services["agentControl"];
  /** Agent calls from other paired machines (ADR 0078). */
  machineCalls?: import("./machines/target.ts").MachineTarget;
  /** Set by the server: the paths this machine serves now, for `describe` (ADR 0182). */
  servedPaths?: (() => import("@ace/protocol").MachinePath[]) | undefined;
  /** Set by the server: a device grant for ace's relay, while signed in (ADR 0182). */
  relayDeviceGrant?:
    | ((deviceId: string, url: string, signal: AbortSignal) => Promise<string | undefined>)
    | undefined;
  /** Projects and threads this machine sends to other machines (ADR 0101). */
  transfers?: import("./transfers/service.ts").DaemonTransfers;
  /** Projects and threads other machines send here (ADR 0101). */
  transferTarget?: import("./transfers/serve.ts").TransferTarget;
  /** This machine's links to other machines (`fleet.request`). */
  fleet?: import("./machines/fleet-links.ts").FleetLinks;
  providerInstalls?: import("./provider-install/sessions.ts").ProviderInstalls;
  notificationPublicKey?: string;
  providerLogin?: import("@ace/accounts").ProviderLoginSessions;
  onboarding?: import("./onboarding.ts").Onboarding;
  providerStatuses?: import("./provider-status.ts").ProviderStatuses;
  previewClient?: import("./preview-client.ts").PreviewClient;
  /** Detected dev servers per thread (`preview.request` list with suggestions). */
  previewSuggestions?: import("./preview-suggestions/tracker.ts").SuggestionTracker;
  automations?: Pick<import("@ace/automations").AutomationService, "handle">;
  /** Webhook automations' URLs, secrets and relayed requests (ADR 0173). */
  automationWebhooks?: import("./automation-webhooks.ts").AutomationWebhookService;
  /** Automations agents made from threads (`source: "thread"`, `includeThreads`). */
  threadAutomations?: import("./agent-control/thread-automations.ts").ThreadAutomations;
  /** Threads whose browser an agent works in now (`browser.browsing.watch`). */
  browsing?: import("./browsing.ts").BrowsingThreads;
  /** Threads whose agent uses Mac apps now (`computer.using.watch`). */
  computerUsing?: import("./computer-using.ts").ComputerUsingThreads;
  /** The Activity read cursor (`activity.reads`). */
  activityReads?: import("./activity-reads.ts").ActivityReads;
  /** What places listed threads in the Threads panel (ADR 0107). */
  sidebarPlacement?: import("./sidebar-placement.ts").SidebarPlacement;
  /** Local checks and verified batch merges of pull requests (`verify.request`). */
  verify?: import("./verify/verify-service.ts").Verify;
  /** Site and app icons for browser and computer-use steps. */
  icons?: import("./icons/icon-service.ts").IconService;
  projects?: import("./projects.ts").Projects;
  threadLifecycle?: import("./thread-lifecycle.ts").ThreadLifecycle;
  /** The utility model and thread titles (`thread.title.regenerate`). */
  utility?: Pick<import("./services/utility.ts").UtilityService, "titles">;
  workspaceActions?: import("./workspace-runtime.ts").WorkspaceRuntime;
  engine?: import("./engine/index.ts").Engine;
  mcp?: Pick<Awaited<ReturnType<typeof import("./mcp.ts").startDaemonMcp>>, "providers"> &
    Partial<Pick<Awaited<ReturnType<typeof import("./mcp.ts").startDaemonMcp>>, "handleHttp">>;
  pi?: import("./services/pi.ts").PiService;
  screen?: ScreenManager;
  /** What ace-media runs on (ADR 0148): its probe's list and each source's steps. */
  mediaAcceleration?: import("@ace/media/acceleration").MediaAccelerationStore | undefined;
  /** This Mac's locked computer use component (`lockedUse.*`); a placeholder when absent. */
  lockedUse?: import("@ace/screen").LockedUseInstaller;
  devices?: import("@ace/devices").DevicesService | import("./lazy-devices.ts").LazyDevices;
  accounts?: AccountService;
  accountManagement?: import("./account-management.ts").AccountManagement;
  cursorAuth?: CursorAuthService;
  providerActivation?: Promise<void>;
  promptFiles?: import("@ace/commands").PromptFiles | undefined;
  skillLibrary?: import("@ace/commands").SkillLibrary | undefined;
  /** Spade, ace's assistant, when this daemon hosts it (ADR 0121). */
  spade?: import("./spade/link.ts").SpadeLink | undefined;
  /** Bot and club asks from threads (ADR 0198). */
  threadAsks?: import("./thread-address/asks.ts").ThreadAsks | undefined;
  spadeBrains?: import("./services/types.ts").Services["spadeBrains"];
  spadeGrantVerify?: import("./services/types.ts").Services["spadeGrantVerify"];
  /** Spade's bots on the person's other machines (ADR 0132). */
  spadeRemote?: import("./spade/remote.ts").SpadeRemote | undefined;
  /** Spade's bots' browsers and screen use (`spade.computer.*`). */
  spadeComputers?: import("./spade/computers.ts").SpadeComputers | undefined;
  commands?: CommandService | undefined;
  files?: FilesService;
  threadFiles?: import("./files-workspaces.ts").FilesWorkspaces;
  /** The daemon's ace-files and its folder watches (ADR 0178). */
  filesNative?: import("./files-tool/wiring.ts").FilesNative;
  relay?: { url: string; keys: KeyPair } | undefined;
  /** Set by `startServer`: serves a relayed main channel with the main-socket handler. */
  relayMain?: ((entry: import("./relay-socket.ts").RelayedMain) => void) | undefined;
  settings?: SettingsService;
  /**
   * Serves outside MCP requests that ace's hosted relay forwards (ADR 0122): the outside
   * endpoint's relay handler once it runs; unset, the relay path answers 404 (`relay-http.ts`).
   */
  outsideMcpHttp?: import("./relay-http.ts").RelayHttpHandler | undefined;
  preview?: DaemonPreviewOptions;
  history?: Pick<DaemonHistory, "handle">;
  usage?: UsageCommands;
  maintenance?: boolean;
  /** The daemon's shared admission gate; the server makes its own when none is given. */
  maintenanceGate?: MaintenanceGate;
  /** The desktop app's update report; the server makes its own when omitted. */
  appUpdate?: import("./app-update-board.ts").AppUpdateBoard;
  /** The data formats the home holds, in each reply to the app's update report (ADR 0177). */
  homeData?: () => import("@ace/protocol").HomeData;
  /** This machine's remote updates (ADR 0113); clients read `unavailable` when omitted. */
  machineUpdate?: {
    install: import("@ace/protocol").MachineInstall;
    record: import("./machine-update/record.ts").RecordStore;
    /** The standalone updater, for a standalone install. */
    updater?: import("./machine-update/standalone-installer.ts").UpdaterPorts;
    platform?: string;
    arch?: string;
  };
  version?: string;
  serviceStatus?: () => readonly import("./services/startup.ts").ServiceStatus[];
  /** Tells the listener when a service starts, degrades or recovers; returns how to stop. */
  serviceChanges?: (listener: () => void) => () => void;
  /** Current and maximum event-loop delay for `/v1/status`. */
  eventLoop?: () => import("./loop-monitor.ts").LoopStatus;
  /** Socket welcomes follow finite listener setup; HTTP discovery remains immediate. */
  ready?: Promise<void>;
  models?: ModelCatalogApi;
  agentRegistry?: Pick<import("@ace/agent-registry").AgentRegistry, "handle">;
  /** Generic ACP agents' catalog rows, told when the person approves an agent's update. */
  acpCatalog?: Pick<NonNullable<import("./services/types.ts").Services["acpCatalog"]>, "updated">;
  port: number;
  remote?: RemoteListener;
  remoteConfig?: import("./config.ts").Config;
  /** This machine's ace account and machine code (ADR 0111). */
  machineAccount?: import("./account-access/machine-account.ts").MachineAccount;
  /** How often an org host's daemon forwards Spade's audit log and reads its policy. */
  orgHostIntervals?: Partial<typeof import("./org-host/link.ts").orgHostIntervals>;
  /** The fetch the org-host link calls ace's account backend with. */
  orgHostFetch?: typeof fetch;
  network?: import("./network.ts").NetworkRuntime;
  webRoot?: string;
  applyRemoteSetting?: (key: string, value: unknown, commit: () => Promise<void>) => Promise<void>;
  now?: () => number;
  runtime?: Partial<DeliveryRuntime>;
  entropy?: EntropySource;
  pairingAddress?: (request: IncomingMessage) => string;
  /** Configured web app origins allowed to read the access routes; the desktop app is always allowed. */
  webOrigins?: readonly string[];
  ticketLimits?: Partial<TicketLimits>;
  token: string;
  hostId: string;
  /** Injected hostname fallback for host.identity. */
  hostName?: string;
  /** The OS host.identity reports; defaults to this process's (`process.platform`). */
  platform?: string;
  store: Store;
  handler: CommandHandler;
  plugins?: { handle(input: unknown): Promise<PluginResponse> };
  /** ace's marketplace (ADR 0168): `marketplace.request` and its change pushes. */
  marketplace?: import("./marketplace/service.ts").MarketplaceService;
  /** The marketplace as the person or an agent in a thread reaches it (ADR 0178 §12.5). */
  marketAgent?: import("./marketplace/market-agent.ts").MarketAgent;
  /** The Suit library (ADR 0150): socket requests, change pushes and its asset URLs. */
  suits?: import("./suits/library.ts").SuitLibrary;
  suitLooks?: import("./suits/looks.ts").SuitLooks;
  /** Collects the live checks devices answer after an agent's preview or keep. */
  suitChecks?: import("./suits/live-checks.ts").SuitLiveChecks;
  browser?: BrowserService;
  /** Delivery by ace-media (D1), while ace-media runs. */
  mediaDelivery?: () => import("./services/media.ts").DaemonDelivery | undefined;
  /** ace-media's process while it runs: its listeners are ace's own (ADR 0194). */
  mediaPid?: () => number | undefined;
  /** The tunnel to this machine's loopback (ADR 0194), once the listeners are up. */
  machineTunnel?: import("./machine-tunnel/host.ts").TunnelHost | undefined;
  userBrowser?: import("./user-browser.ts").UserBrowserService;
  review?: ReviewPort;
  replayLimit?: number;
  idleTimeoutMs?: number;
  /** Budget and hello deadline for sockets that have not authenticated yet. */
  preAuth?: Partial<import("./socket-admission.ts").PreAuthLimits>;
  pressure?: Partial<PressureOptions>;
  log?: (error: unknown) => void;
  /** A warn-level line in the daemon's redacting log: a request refused for a reason worth fixing. */
  warn?: (message: string, fields: object) => void;
  /** An info-level line in the daemon's log: how long a start took, network by network. */
  info?: (message: string, fields: object) => void;
  health?: () => Promise<DiagnosticsHealth>;
  doctor?: () => Promise<import("@ace/protocol").DiagnosticReport>;
  toolchains?: () => Promise<import("@ace/protocol").Toolchain[]>;
  doctorFix?: (assertAuthorized: () => void) => Promise<{
    report: import("@ace/protocol").DiagnosticReport;
    repairs: import("@ace/protocol").DiagnosticRepair[];
  }>;
  supportFiles?: FilesService;
  context?: {
    downloadAttachment?: import("@ace/context").ContextService["downloadAttachment"];
    readAttachment?(
      device: string,
      thread: string,
      hash: string,
      variant: "original" | "thumbnail",
      offset: number,
      limit: number,
      access?: () => boolean,
    ): Promise<{ mimeType: string; bytes: number; data: Buffer }>;
    draftWorkspace?(device: string, draftId: string): Promise<string>;
    handle(
      device: string,
      request: ContextRequest,
      access?: (thread?: string) => boolean,
    ): Promise<ContextResult>;
  };
  /** Local-token clients can read all threads by default. */
  canReadThread?: (deviceId: DeviceId, threadId: ThreadId) => boolean;
  notifications?: Pick<
    NotificationWorker,
    "connectDevice" | "disconnect" | "updatePresence" | "register" | "preferences" | "snooze"
  > &
    Partial<Pick<NotificationWorker, "revoke" | "getPreferences" | "feed" | "unregister">> & {
      /** A phone took a live `notification` frame; waiting deliveries may skip the push. */
      acknowledge?(device: DeviceId, id: string): void;
    };
  onDisconnect?: (deviceId: DeviceId | undefined) => void;
}
