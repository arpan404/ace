import type { NotificationWorker, NotificationChannels } from "@ace/notify";
import { loadNotificationChannels } from "./notification-config.ts";
import { createDaemonNotifications, type DaemonNotifications } from "./notifications.ts";
import { join } from "node:path";
import { type CommandHandler, stubHandler } from "./commands.ts";
import { type Config, logger, readConfig } from "./config.ts";
import { acquireLock, loadHostId, loadToken } from "./local-files.ts";
import { startServer } from "./server.ts";
import { Store } from "./store.ts";
export { Store } from "./store.ts";
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
  notificationChannels?: Omit<NotificationChannels, "websocket">,
): Promise<{
  url: string;
  tokenPath: string;
  store: Store;
  notifications: NotificationWorker;
  close(): Promise<void>;
}> {
  const unlock = acquireLock(config.dataDir);
  const log = logger(config.logLevel);
  let store: Store | undefined;
  let notifications: DaemonNotifications | undefined;
  let closeChannels = noop;
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  const closeResources = async () => {
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
            unlock();
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
    server = await startServer({
      port: config.port,
      token,
      hostId,
      store,
      handler,
      notifications: notifications.service,
      log: (error) => log("error", "WebSocket failure", error),
    });
    notifications.setSender(server.notify);
    await notifications.start();
    let closing: Promise<void> | undefined;
    return {
      url: server.url,
      tokenPath,
      store,
      notifications: notifications.service,
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
