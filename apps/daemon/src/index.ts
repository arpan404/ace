import { createDaemonReview } from "./review.ts";
import type { ReviewExecutor } from "@ace/review";
import { writeFileSync, unlinkSync } from "node:fs";
import type { NotificationWorker, NotificationChannels } from "@ace/notify";
import type { Toolkit } from "@ace/mcp-server";
import { join } from "node:path";
import { remoteListener } from "./network.ts";
import { startDaemonMcp } from "./mcp.ts";
import { loadNotificationChannels } from "./notification-config.ts";
import { createDaemonNotifications, type DaemonNotifications } from "./notifications.ts";
import { type CommandHandler, stubHandler } from "./commands.ts";
import { type Config, logger, readConfig } from "./config.ts";
import { acquireLock, loadHostId, loadToken } from "./local-files.ts";
import { startServer } from "./server.ts";
import { Store } from "./store.ts";
export { createDaemonReview, type ReviewPort } from "./review.ts";
export { Store, type StoreOptions } from "./store.ts";
export {
  createDevThread,
  stubHandler,
  type CommandHandler,
  type CommandContext,
} from "./commands.ts";
export { readConfig } from "./config.ts";
const noop = () => {};

export async function startDaemon(
  config: Config = readConfig(),
  handler: CommandHandler = stubHandler(),
  toolkits: readonly Toolkit[] = [],
  notificationChannels?: Omit<NotificationChannels, "websocket">,
  reviewExecutor?: ReviewExecutor,
): Promise<{
  url: string;
  tokenPath: string;
  store: Store;
  notifications: NotificationWorker;
  mcp: Awaited<ReturnType<typeof startDaemonMcp>>;
  remoteUrl?: string;
  fingerprint?: string;
  close(): Promise<void>;
}> {
  const unlock = acquireLock(config.dataDir);
  const log = logger(config.logLevel);
  let store: Store | undefined;
  let notifications: DaemonNotifications | undefined;
  let closeChannels = noop;
  let mcp: Awaited<ReturnType<typeof startDaemonMcp>> | undefined;
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let review: ReturnType<typeof createDaemonReview> | undefined;
  let endpointPath: string | undefined;
  const closeResources = async () => {
    try {
      await review?.close();
      await mcp?.close();
    } finally {
      try {
        await server?.close();
      } finally {
        try {
          await notifications?.close();
        } finally {
          try {
            closeChannels();
          } finally {
            try {
              store?.close();
            } finally {
              try {
                if (endpointPath) unlinkSync(endpointPath);
              } finally {
                unlock();
              }
            }
          }
        }
      }
    }
  };
  try {
    const { token, tokenPath } = loadToken(config.dataDir);
    const hostId = loadHostId(config.dataDir);
    store = new Store(join(config.dataDir, "events.sqlite"), (error) =>
      log("error", "Event subscriber failed", error),
    );
    review = createDaemonReview(config.dataDir, store, reviewExecutor);
    mcp = await startDaemonMcp(store, toolkits);
    const configured = notificationChannels
      ? { channels: notificationChannels, close: closeChannels }
      : await loadNotificationChannels();
    closeChannels = configured.close;
    notifications = createDaemonNotifications(
      config.dataDir,
      store,
      () => log("error", "Notification service failure"),
      configured.channels,
    );
    const remote = await remoteListener(config);
    server = await startServer({
      ...(remote ? { remote } : {}),
      port: config.port,
      token,
      hostId,
      store,
      handler,
      review,
      notifications: notifications.service,
      log: (error) => log("error", "WebSocket failure", error),
    });
    notifications.setSender(server.notify);
    await notifications.start();
    const path = join(config.dataDir, "daemon-endpoint");
    writeFileSync(path, server.httpUrl, { mode: 0o600 });
    endpointPath = path;
    let closing: Promise<void> | undefined;
    return {
      url: server.url,
      ...(server.remoteUrl && server.fingerprint
        ? { remoteUrl: server.remoteUrl, fingerprint: server.fingerprint }
        : {}),
      tokenPath,
      store,
      notifications: notifications.service,
      mcp,
      close() {
        closing ??= closeResources();
        return closing;
      },
    };
  } catch (error) {
    await closeResources().catch(() => {});
    throw error;
  }
}
