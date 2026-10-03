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
  /** Startup deadlines and scheduler are injected at the timer boundary. */
  startup?: Partial<import("./startup.ts").StartupRuntime>;
  claude?: DaemonClaudeOptions;
  screen?: ScreenManager;
  commands?: DaemonCommandIntegration;
  config?: Config;
  /** Explicit owner-approved local bindings. Remote clients cannot send paths/argv. */
  acpBindings?: readonly import("@ace/agent-registry").LocalBinding[];
  acpManagers?: Partial<Record<"npm" | "uv", string>>;
  acpMcpServers?: readonly unknown[];
  acpEnvironment?(identity: import("@ace/protocol").AcpIdentity): {
    env: NodeJS.ProcessEnv;
    loginRevision: string;
  };
  handler?: CommandHandler | undefined;
  engine?: EngineOptions & { adapterDiscovery?: typeof discoverProviders };
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
