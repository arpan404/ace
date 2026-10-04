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
  accounts?: Pick<
    import("../account-management.ts").AccountManagementOptions,
    "env" | "discovery" | "terminal"
  >;
  /** Local metadata process boundary, never accepted from socket clients. */
  modelDiscovery?: import("@ace/models").DiscoveryOptions;
  conductor?: import("../conductor-runtime.ts").ConductorRuntimeOptions;
  projects?: import("../projects.ts").ProjectsOptions;
  workspaceActions?: import("../workspace-runtime.ts").WorkspaceRuntimeOptions;
  /** The host owns daemon cancellation, including initialization before endpoint discovery. */
  signal?: AbortSignal;
  files?: Pick<import("@ace/files").FilesOptions, "workspaceRuntime" | "maxReservedBytes">;
  /** Startup deadlines and scheduler are injected at the timer boundary. */
  startup?: Partial<import("./startup.ts").StartupRuntime>;
  agentControl?: {
    policy?: Partial<import("@ace/protocol").DelegationPolicy>;
    /** Inject the host Git boundary; never exposed as MCP input. */
    handoffGit?: () => import("../agent-control/handoffs.ts").HandoffGit;
    extensions?: import("../agent-control/tools.ts").AgentControlExtensions;
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
  preview?: DaemonPreviewOptions;
  review?: DaemonReviewOptions;
  history?: DaemonHistoryOptions;
};
