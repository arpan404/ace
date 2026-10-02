import { discoverAdapters } from "./engine/adapters.ts";
import type { discoverProviders } from "@ace/provider-kit/discovery";
import { Engine, type EngineOptions } from "./engine/index.ts";
export { Engine, AdapterRegistry, type EngineOptions, type EngineClock } from "./engine/index.ts";
import { homedir } from "node:os";
import { createRedactor } from "@ace/redaction";
import {
  logFields,
  createFileSink,
  createLogger,
  createHealthMonitor,
  type HealthOptions,
} from "@ace/diagnostics";
import { realpath } from "node:fs/promises";
import { PluginLaunches } from "./plugin-launches.ts";
import { randomUUID } from "node:crypto";
import {
  PluginManager,
  PluginService,
  preparePluginSession,
  launchPluginProcess,
} from "@ace/plugins";
import type { SpawnOptions } from "@ace/provider-kit/process";
import type { Provider } from "@ace/plugins";
import { ContextService } from "@ace/context";
import type { ModelCatalog, InstanceInput } from "@ace/models";
import { openDaemonModels } from "./models.ts";
import { writeFileSync, unlinkSync } from "node:fs";
import type { NotificationWorker, NotificationChannels } from "@ace/notify";
import type { Toolkit } from "@ace/mcp-server";
import { join } from "node:path";
import { BrowserService, type BrowserServiceOptions } from "@ace/browser";
import { ItemId, ThreadId } from "@ace/protocol";
import { remoteListener } from "./network.ts";
import { startDaemonMcp } from "./mcp.ts";
import { loadNotificationChannels } from "./notification-config.ts";
import { createDaemonNotifications, type DaemonNotifications } from "./notifications.ts";
import { type CommandHandler } from "./commands.ts";
import { type Config, readConfig } from "./config.ts";
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
export type DaemonOptions = EngineOptions & {
  toolkits?: readonly Toolkit[];
  adapterDiscovery?: typeof discoverProviders;
};
const isToolkitList = (input: DaemonOptions | readonly Toolkit[]): input is readonly Toolkit[] =>
  Array.isArray(input);

export async function startDaemon(
  config: Config = readConfig(),
  handler?: CommandHandler,
  options: DaemonOptions | readonly Toolkit[] = {},
  notificationChannels?: Omit<NotificationChannels, "websocket">,
  modelInstances: readonly InstanceInput[] = [],
  workload?: HealthOptions["workload"],
  browserOptions: Omit<BrowserServiceOptions, "dataDir" | "onArtifact"> = {},
): Promise<{
  url: string;
  tokenPath: string;
  store: Store;
  preparePlugins(provider: Provider, root: string): ReturnType<typeof preparePluginSession>;
  launchPlugins(
    provider: Provider,
    root: string,
    options: SpawnOptions,
  ): ReturnType<typeof launchPluginProcess>;
  browser: BrowserService;
  context: ContextService;
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
  const loggingContext = { home: homedir(), env: process.env };
  let log: ReturnType<typeof createLogger> | undefined;
  let health: ReturnType<typeof createHealthMonitor> | undefined;
  let store: Store | undefined;
  let engine: Engine | undefined;
  let plugins: PluginManager | undefined;
  let launches: PluginLaunches | undefined;
  let browser: BrowserService | undefined;
  let context: ContextService | undefined;
  let maintenance: ReturnType<typeof setInterval> | undefined;
  let models: ModelCatalog | undefined;
  let notifications: DaemonNotifications | undefined;
  let closeChannels = noop;
  let mcp: Awaited<ReturnType<typeof startDaemonMcp>> | undefined;
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let endpointPath: string | undefined;
  const closeResources = async () => {
    if (maintenance) clearInterval(maintenance);
    try {
      try {
        await launches?.close();
      } finally {
        await mcp?.close();
      }
    } finally {
      try {
        await server?.close();
      } finally {
        try {
          try {
            await engine?.close();
            await browser?.close();
          } finally {
            await notifications?.close();
          }
        } finally {
          try {
            closeChannels();
          } finally {
            try {
              try {
                try {
                  await context?.close();
                } finally {
                  await models?.close();
                }
              } finally {
                try {
                  plugins?.close();
                } finally {
                  store?.close();
                }
              }
            } finally {
              try {
                if (endpointPath) unlinkSync(endpointPath);
              } finally {
                health?.close();
                try {
                  await log?.close();
                } finally {
                  unlock();
                }
              }
            }
          }
        }
      }
    }
  };
  try {
    const sink = await createFileSink({
      directory: join(config.dataDir, "logs"),
      fileBytes: 1024 * 1024,
      totalBytes: 8 * 1024 * 1024,
      context: loggingContext,
    }).catch(() => ({
      async write() {
        throw new Error("File logging unavailable");
      },
      async close() {},
    }));
    log = createLogger({
      sink,
      now: Date.now,
      redact: createRedactor(loggingContext),
      level: config.logLevel,
    });
    const ownedLog = log;
    health = createHealthMonitor({
      database: join(config.dataDir, "events.sqlite"),
      now: Date.now,
      workload: () => {
        const current = workload?.() ?? engine?.workload() ?? { activeSessions: null, queues: {} };
        return {
          ...current,
          queues: {
            ...current.queues,
            "daemon.socketInput": server?.diagnosticsQueues().socketInput ?? 0,
            "daemon.healthRequests": server?.diagnosticsQueues().healthRequests ?? 0,
          },
        };
      },
      logs: ownedLog.stats,
    });
    const { token, tokenPath } = loadToken(config.dataDir);
    const hostId = loadHostId(config.dataDir);
    store = new Store(join(config.dataDir, "events.sqlite"), (error) =>
      ownedLog.log("error", "Event subscriber failed", error),
    );
    if (!handler) {
      engine = new Engine(store, {
        ...engineOptions,
        registry:
          engineOptions.registry ?? (await discoverAdapters(engineOptions.adapterDiscovery)),
        onError:
          engineOptions.onError ?? ((error) => ownedLog.log("error", "Engine failure", error)),
      });
      handler = engine.handler;
    }
    plugins = await PluginManager.open({
      root: join(await realpath(config.dataDir), "plugins"),
      now: Date.now,
      id: randomUUID,
    });
    const ownedPlugins = plugins;
    launches = new PluginLaunches((provider, root, options) =>
      launchPluginProcess(ownedPlugins, provider, root, options),
    );
    const ownedLaunches = launches;
    const ownedStore = store;
    browser = new BrowserService({
      ...browserOptions,
      dataDir: config.dataDir,
      onArtifact: (rawThreadId, artifact) => {
        const threadId = ThreadId.parse(rawThreadId);
        const thread = ownedStore.getThread(threadId);
        if (!thread) throw new Error("Recording thread no longer exists");
        ownedStore.appendEvents(threadId, [
          {
            type: "item.created",
            item: {
              type: "artifact",
              id: ItemId.parse(randomUUID()),
              ...(thread.rootAgentId ? { agentId: thread.rootAgentId } : {}),
              createdAt: Date.now(),
              complete: true,
              source: "browser",
              ...artifact,
            },
          },
        ]);
      },
    });
    context = await ContextService.open({
      root: join(config.dataDir, "context"),
      now: Date.now,
      id: randomUUID,
      authorize: (_device, thread) => ownedStore.getThread(ThreadId.parse(thread)) !== undefined,
      workspace: (thread) => {
        const entity = ownedStore.getThread(ThreadId.parse(thread));
        return entity ? ownedStore.getWorkspacePath(entity.workspaceId) : undefined;
      },
    });
    const ownedContext = context;
    models = openDaemonModels(config.dataDir, modelInstances);
    mcp = await startDaemonMcp(store, toolkits);
    const configured = notificationChannels
      ? { channels: notificationChannels, close: closeChannels }
      : await loadNotificationChannels();
    closeChannels = configured.close;
    notifications = createDaemonNotifications(
      config.dataDir,
      store,
      () => ownedLog.log("error", "Notification service failure"),
      configured.channels,
    );
    const remote = await remoteListener(config);
    server = await startServer({
      context,
      ...(remote ? { remote } : {}),
      port: config.port,
      token,
      hostId,
      store,
      handler,
      plugins: new PluginService(plugins),
      browser,
      models,
      notifications: notifications.service,
      health: health.collect,
      log: (error) => ownedLog.log("error", "WebSocket failure", error),
    });
    ownedLog.log("info", "Daemon listening", logFields([["url", server.url]]));
    notifications.setSender(server.notify);
    await notifications.start();
    const path = join(config.dataDir, "daemon-endpoint");
    writeFileSync(path, server.httpUrl, { mode: 0o600 });
    endpointPath = path;
    let maintaining = false;
    const maintain = () => {
      if (maintaining) return;
      maintaining = true;
      void ownedContext.uploads
        .collect()
        .catch((error: unknown) => ownedLog.log("error", "Attachment maintenance failed", error))
        .finally(() => {
          maintaining = false;
        });
    };
    maintain();
    maintenance = setInterval(maintain, 60_000);
    maintenance.unref();
    let closing: Promise<void> | undefined;
    return {
      url: server.url,
      ...(server.remoteUrl && server.fingerprint
        ? { remoteUrl: server.remoteUrl, fingerprint: server.fingerprint }
        : {}),
      tokenPath,
      store,
      preparePlugins: (provider, root) => preparePluginSession(ownedPlugins, provider, root),
      launchPlugins: (provider, root, options) => ownedLaunches.launch(provider, root, options),
      browser,
      context: ownedContext,
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
