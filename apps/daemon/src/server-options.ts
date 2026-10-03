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
  files?: FilesService;
  relay?: { url: string; keys: KeyPair };
  settings?: SettingsService;
  preview?: DaemonPreviewOptions;
  history?: Pick<DaemonHistory, "handle">;
  usage?: UsageCommands;
  maintenance?: boolean;
  version?: string;
  models?: ModelCatalogApi;
  port: number;
  remote?: RemoteListener;
  now?: () => number;
  runtime?: Partial<DeliveryRuntime>;
  entropy?: EntropySource;
  pairingAddress?: (request: IncomingMessage) => string;
  ticketLimits?: Partial<TicketLimits>;
  token: string;
  hostId: string;
  store: Store;
  handler: CommandHandler;
  plugins?: { handle(input: unknown): Promise<PluginResponse> };
  browser?: BrowserService;
  review?: ReviewPort;
  replayLimit?: number;
  idleTimeoutMs?: number;
  pressure?: Partial<PressureOptions>;
  log?: (error: unknown) => void;
  health?: () => Promise<DiagnosticsHealth>;
  context?: {
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
