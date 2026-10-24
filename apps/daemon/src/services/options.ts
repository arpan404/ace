import type { CursorAdapterOptions } from "@ace/adapter-cursor";
import type { DevicesService } from "@ace/devices";
import type { ScreenManager } from "@ace/screen";
import type { DaemonCommandIntegration } from "./commands.ts";
import type { Config } from "../config.ts";
import type { CommandHandler } from "../commands.ts";
import type { EngineOptions } from "../engine/index.ts";
import type { discoverProviders } from "@ace/provider-kit/discovery";
import type { Toolkit } from "@ace/mcp-server";
import type { NotificationChannels } from "@ace/notify";
import type { InstanceInput } from "@ace/models";
import type { HealthOptions } from "@ace/diagnostics";
import type { BrowserServiceOptions } from "@ace/browser";
import type { DaemonPreviewOptions } from "../preview.ts";
import type { DaemonReviewOptions } from "../review.ts";
import type { DaemonHistoryOptions } from "../history.ts";
import type { DaemonClaudeOptions } from "./claude.ts";
export type DaemonOptions = {
  /** Free space of the volume holding ACE_HOME, reported with storage failures. */
  diskSpace?: import("../sqlite-failure.ts").DiskSpace;
  /** Event-loop stall measurement clock; tests drive drift without sleeping. */
  loopClock?: import("../loop-monitor.ts").LoopClock;
  /** Main-thread stall watchdog timing; tests shorten it. */
  stallTiming?: Partial<import("../stall-watchdog.ts").StallWatchdogTiming>;
  storageSchedule?: import("../storage/schedule.ts").StorageSchedule;
  /** Automatic data-retention pass timing; tests shorten it. */
  retentionTiming?: import("../storage/data-retention-policy.ts").RetentionTiming;
  diagnostics?: {
    doctor(): Promise<import("@ace/protocol").DiagnosticReport>;
    toolchains(): Promise<import("@ace/protocol").Toolchain[]>;
  };
  accounts?: Pick<
    import("../account-management.ts").AccountManagementOptions,
    "env" | "discovery" | "terminal"
  >;
  providerStatus?: import("../provider-status.ts").ProviderStatusOptions;
  /** Local metadata process boundary, never accepted from socket clients. */
  modelDiscovery?: import("@ace/models").DiscoveryOptions;
  projects?: import("../projects.ts").ProjectsOptions;
  workspaceActions?: import("../workspace-runtime.ts").WorkspaceRuntimeOptions;
  /** Titles and commit/PR drafts: the one-shot runner and CLI lookup tests replace. */
  utility?: import("./utility.ts").UtilityDaemonOptions;
  /** The host owns daemon cancellation, including initialization before endpoint discovery. */
  signal?: AbortSignal;
  files?: Pick<import("@ace/files").FilesOptions, "workspaceRuntime" | "maxReservedBytes">;
  /** Startup deadlines and scheduler are injected at the timer boundary. */
  startup?: Partial<import("./startup.ts").StartupRuntime>;
  /**
   * Stops every child process group the daemon still owns, SIGTERM then SIGKILL after
   * `graceMs`, once a shutdown's polite window has passed. Tests substitute it.
   */
  stopProcesses?: (graceMs: number) => Promise<void>;
  agentControl?: {
    policy?: Partial<import("@ace/protocol").DelegationPolicy>;
    /** Inject the host Git boundary; never exposed as MCP input. */
    handoffGit?: () => import("../agent-control/handoffs.ts").HandoffGit;
    extensions?: import("../agent-control/tools.ts").AgentControlExtensions;
  };
  /** Transfers to other machines (ADR 0099): tests drop connections and shorten waits. */
  transfers?: {
    transport?: import("../transfers/client.ts").TransferTransport;
    sleep?(ms: number, signal: AbortSignal): Promise<void>;
    offlineMs?: number;
    /** Target origin clone deadline; host-injected so stalled-origin tests stay fast. */
    cloneTimeoutMs?: number;
  };
  /** Calls to other paired machines (ADR 0078): the transport and poll interval. */
  machines?: {
    transport?: import("../machines/transport.ts").MachineTransport;
    pollMs?: number;
    /** Redeems another machine's pairing link when Settings links to it. */
    redeem?: import("../machines/fleet-links.ts").FleetLinkDeps["redeem"];
  };
  claude?: DaemonClaudeOptions;
  pi?: import("./pi.ts").PiDaemonOptions;
  screen?: ScreenManager;
  devices?: DevicesService;
  commands?: DaemonCommandIntegration;
  config?: Config;
  /** Explicit owner-approved local bindings, also available through admin registry.bind. */
  acpBindings?: readonly import("@ace/agent-registry").LocalBinding[];
  acpManagers?: Partial<Record<"npm" | "uv", string>>;
  acpMcpServers?: readonly unknown[];
  acpEnvironment?(identity: import("@ace/protocol").AcpIdentity): {
    env: NodeJS.ProcessEnv;
    loginRevision: string;
  };
  handler?: CommandHandler | undefined;
  engine?: EngineOptions & {
    adapterDiscovery?: typeof discoverProviders;
    cursor?: CursorAdapterOptions;
  };
  toolkits?: readonly Toolkit[];
  /** Worker spawner is injectable without changing notification policy. */
  notificationWorker?: ConstructorParameters<
    typeof import("@ace/notify").NotificationWorker
  >[0]["spawn"];
  notificationChannels?: Omit<NotificationChannels, "websocket">;
  modelInstances?: readonly InstanceInput[];
  workload?: HealthOptions["workload"];
  browser?: Omit<BrowserServiceOptions, "dataDir" | "onArtifact">;
  /** "Use my Chrome" overrides for tests: where browsers keep native hosts, and which Node runs one. */
  userBrowser?: Partial<
    Pick<import("../user-browser.ts").UserBrowserOptions, "home" | "node" | "extraHostDirs">
  >;
  preview?: DaemonPreviewOptions;
  review?: DaemonReviewOptions;
  history?: DaemonHistoryOptions;
};
