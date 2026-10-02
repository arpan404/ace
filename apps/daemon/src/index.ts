import { Engine, type EngineOptions } from "./engine/index.ts";
export { Engine, AdapterRegistry, type EngineOptions, type EngineClock } from "./engine/index.ts";
import type { ModelCatalog, InstanceInput } from "@ace/models";
import { openDaemonModels } from "./models.ts";
import { writeFileSync, unlinkSync } from "node:fs";
import type { NotificationWorker, NotificationChannels } from "@ace/notify";
import type { Toolkit } from "@ace/mcp-server";
import { join } from "node:path";
import { remoteListener } from "./network.ts";
import { startDaemonMcp } from "./mcp.ts";
import { loadNotificationChannels } from "./notification-config.ts";
import { createDaemonNotifications, type DaemonNotifications } from "./notifications.ts";
import { type CommandHandler } from "./commands.ts";
import { type Config, logger, readConfig } from "./config.ts";
import { acquireLock, loadHostId, loadToken } from "./local-files.ts";
import { startServer } from "./server.ts";
import { Store } from "./store.ts";
export { Store, type StoreOptions } from "./store.ts";
export {
  createDevThread,
  stubHandler,
  type CommandHandler,
  type CommandContext,
} from "./commands.ts";
export { readConfig } from "./config.ts";
const noop = () => {};
export type DaemonOptions = EngineOptions & { toolkits?: readonly Toolkit[] };
const isToolkitList = (input: DaemonOptions | readonly Toolkit[]): input is readonly Toolkit[] =>
  Array.isArray(input);

export async function startDaemon(
  config: Config = readConfig(),
  handler?: CommandHandler,
  options: DaemonOptions | readonly Toolkit[] = {},
  notificationChannels?: Omit<NotificationChannels, "websocket">,
  modelInstances: readonly InstanceInput[] = [],
): Promise<{
  url: string;
  tokenPath: string;
  store: Store;
  models: ModelCatalog;
  notifications: NotificationWorker;
  mcp: Awaited<ReturnType<typeof startDaemonMcp>>;
  remoteUrl?: string;
  fingerprint?: string;
  close(): Promise<void>;
}> {
  const engineOptions = isToolkitList(options) ? {} : options;
  const toolkits = isToolkitList(options) ? options : (options.toolkits ?? []);
  const unlock = acquireLock(config.dataDir);
  const log = logger(config.logLevel);
  let store: Store | undefined;
  let engine: Engine | undefined;
  let models: ModelCatalog | undefined;
  let notifications: DaemonNotifications | undefined;
  let closeChannels = noop;
  let mcp: Awaited<ReturnType<typeof startDaemonMcp>> | undefined;
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let endpointPath: string | undefined;
  const closeResources = async () => {
    try {
      await mcp?.close();
    } finally {
      try {
        await server?.close();
      } finally {
        try {
          try {
            await engine?.close();
          } finally {
            await notifications?.close();
          }
        } finally {
          try {
            closeChannels();
          } finally {
            try {
              try {
                await models?.close();
              } finally {
                store?.close();
              }
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
    if (!handler) {
      engine = new Engine(store, {
        ...engineOptions,
        onError: engineOptions.onError ?? ((error) => log("error", "Engine failure", error)),
      });
      handler = engine.handler;
    }
    models = openDaemonModels(config.dataDir, modelInstances);
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
      models,
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
      models,
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
