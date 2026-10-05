import type { DevicesService } from "@ace/devices";
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
  providerStatuses?: import("./provider-status.ts").ProviderStatuses;
  previewClient?: import("./preview-client.ts").PreviewClient;
  conductor?: import("./conductor-runtime.ts").ConductorRuntime;
  automations?: Pick<import("@ace/automations").AutomationService, "handle">;
  /** The Activity read cursor (`activity.reads`). */
  activityReads?: import("./activity-reads.ts").ActivityReads;
  projects?: import("./projects.ts").Projects;
  workspaceActions?: import("./workspace-runtime.ts").WorkspaceRuntime;
  engine?: import("./engine/index.ts").Engine;
  mcp?: Pick<Awaited<ReturnType<typeof import("./mcp.ts").startDaemonMcp>>, "providers">;
  pi?: import("./services/pi.ts").PiService;
  screen?: ScreenManager;
  devices?: DevicesService;
  accounts?: AccountService;
  cursorAuth?: CursorAuthService;
  commands?: CommandService;
  files?: FilesService;
  threadFiles?: import("./files-workspaces.ts").FilesWorkspaces;
  relay?: { url: string; keys: KeyPair };
  settings?: SettingsService;
  preview?: DaemonPreviewOptions;
  history?: Pick<DaemonHistory, "handle">;
  usage?: UsageCommands;
  maintenance?: boolean;
  version?: string;
  serviceStatus?: () => readonly import("./services/startup.ts").ServiceStatus[];
  /** Socket welcomes follow finite listener setup; HTTP discovery remains immediate. */
  ready?: Promise<void>;
  models?: ModelCatalogApi;
  agentRegistry?: Pick<import("@ace/agent-registry").AgentRegistry, "handle">;
  port: number;
  remote?: RemoteListener;
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
  store: Store;
  handler: CommandHandler;
  plugins?: { handle(input: unknown): Promise<PluginResponse> };
  browser?: BrowserService;
  review?: ReviewPort;
  replayLimit?: number;
  idleTimeoutMs?: number;
  /** Budget and hello deadline for sockets that have not authenticated yet. */
  preAuth?: Partial<import("./socket-admission.ts").PreAuthLimits>;
  pressure?: Partial<PressureOptions>;
  log?: (error: unknown) => void;
  health?: () => Promise<DiagnosticsHealth>;
  context?: {
    draftWorkspace?(device: string, draftId: string): Promise<string>;
    handle(device: string, request: ContextRequest, access?: () => boolean): Promise<ContextResult>;
  };
  /** Local-token clients can read all threads by default. */
  canReadThread?: (deviceId: DeviceId, threadId: ThreadId) => boolean;
  notifications?: Pick<
    NotificationWorker,
    "connectDevice" | "disconnect" | "updatePresence" | "register" | "preferences" | "snooze"
  > &
    Partial<Pick<NotificationWorker, "revoke">>;
  onDisconnect?: (deviceId: DeviceId | undefined) => void;
}
