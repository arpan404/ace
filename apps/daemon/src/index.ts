export { runDaemonProcess } from "./process-daemon.ts";
export { createDaemonCommandLibrary } from "./command-library.ts";
export { connectDaemonCommandEvents, type CommandEventSource } from "./command-events.ts";
export type { DaemonCommandIntegration } from "./services/commands.ts";
import { fingerprint as relayFingerprint } from "@ace/secure-channel";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createRedactor } from "@ace/redaction";
import { logFields, createFileSink, createLogger, createHealthMonitor } from "@ace/diagnostics";
import { readConfig } from "./config.ts";
import { acquireLock, loadHostId, loadToken } from "./local-files.ts";
import { remoteListener } from "./network.ts";
import { startServer, type ServerOptions } from "./server.ts";
import { Store } from "./store.ts";
import { Resources } from "./services/resources.ts";
import { serviceFactories, requireService, type ServiceContext } from "./services/composition.ts";
import { ServiceStartup, systemStartup } from "./services/startup.ts";
import type { DaemonOptions } from "./services/options.ts";
export type { DaemonOptions } from "./services/options.ts";
export { Engine, AdapterRegistry, type EngineOptions, type EngineClock } from "./engine/index.ts";
export { Store, type StoreOptions } from "./store.ts";
export { readConfig } from "./config.ts";
export type { SearchScheduler } from "./search-runtime.ts";
export {
  createDevThread,
  stubHandler,
  type CommandHandler,
  type CommandContext,
} from "./commands.ts";
export { createDaemonReview, type ReviewPort, type DaemonReviewOptions } from "./review.ts";
export { createDaemonUsage, loadUsageSettings, type UsageCommands } from "./usage.ts";
export type { DaemonPreview, DaemonPreviewOptions } from "./preview.ts";
export { readHistoryInstances, type DaemonHistoryOptions } from "./history.ts";
export type { HistoryAdapterPort } from "./history-continuation.ts";

export async function startDaemon(options: DaemonOptions = {}) {
  options.signal?.throwIfAborted();
  const config = options.config ?? readConfig();
  const unlock = acquireLock(config.dataDir);
  const resources = new Resources();
  const lifetime = new AbortController();
  resources.onShutdown(() => lifetime.abort());
  let initialized = false;
  const abort = () => {
    resources.beginShutdown();
    if (initialized) void closeResources().catch(() => {});
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  resources.own(() => options.signal?.removeEventListener("abort", abort));
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let endpointPath: string | undefined;
  let closing: Promise<void> | undefined;
  const closeResources = () => {
    closing ??= disposeResources();
    return closing;
  };
  const disposeResources = async () => {
    resources.beginShutdown();
    try {
      await server?.close();
    } finally {
      try {
        await resources.close();
      } finally {
        try {
          if (endpointPath) unlinkSync(endpointPath);
        } finally {
          unlock();
        }
      }
    }
  };
  try {
    const context = { home: homedir(), env: process.env };
    const sink = await createFileSink({
      directory: join(config.dataDir, "logs"),
      fileBytes: 1024 * 1024,
      totalBytes: 8 * 1024 * 1024,
      context,
    }).catch(() => ({
      async write() {
        throw new Error("File logging unavailable");
      },
      async close() {},
    }));
    const log = createLogger({
      sink,
      now: Date.now,
      redact: createRedactor(context),
      level: config.logLevel,
    });
    resources.own(() => log.close());
    lifetime.signal.throwIfAborted();
    const serviceContext: ServiceContext = {
      signal: lifetime.signal,
      config,
      options,
      now: Date.now,
      id: randomUUID,
      log,
      resources,
      services: {
        handler: {
          handle: (command) => ({ commandId: command.id, ok: false, error: "engine_unavailable" }),
        },
      },
      onListen: [],
      store: new Store(join(config.dataDir, "events.sqlite"), (error) =>
        log.log("error", "Event subscriber failed", error),
      ),
    };
    const store = serviceContext.store;
    resources.own(() => store.close());
    const health = createHealthMonitor({
      database: join(config.dataDir, "events.sqlite"),
      now: Date.now,
      workload: () => {
        const current = options.workload?.() ??
          serviceContext.services.engine?.workload() ?? { activeSessions: null, queues: {} };
        return {
          ...current,
          queues: {
            ...current.queues,
            "daemon.socketInput": server?.diagnosticsQueues().socketInput ?? 0,
            "daemon.healthRequests": server?.diagnosticsQueues().healthRequests ?? 0,
          },
        };
      },
      logs: log.stats,
    });
    resources.own(() => health.close());
    const startup = new ServiceStartup(serviceContext, { ...systemStartup, ...options.startup });
    await startup.start(serviceFactories);
    const services = serviceContext.services;
    const handler = requireService(services.handler, "engine");
    const { token, tokenPath } = loadToken(config.dataDir);
    const hostId = loadHostId(config.dataDir);
    const remote = await remoteListener(config);
    const serverOptions: ServerOptions = {
      ...services,
      handler,
      serviceStatus: startup.status,
      ...(remote ? { remote } : {}),
      maintenance: process.env.ACE_MAINTENANCE === "1",
      version: process.env.ACE_VERSION ?? "development",
      port: config.port,
      token,
      hostId,
      store,
      ...(options.preview ? { preview: options.preview } : {}),
      health: health.collect,
      log: (error) => log.log("error", "WebSocket failure", error),
    };
    // Feature services publish only after initialization. Socket handlers read the
    // live registry, so a service can become available after endpoint discovery.
    for (const key of [
      "screen",
      "accounts",
      "commands",
      "files",
      "relay",
      "handler",
      "plugins",
      "browser",
      "context",
      "settings",
      "models",
      "mcp",
      "notifications",
      "review",
      "history",
      "usage",
      "agentRegistry",
      "pi",
    ] as const)
      Object.defineProperty(serverOptions, key, {
        enumerable: true,
        configurable: true,
        get: () => services[key],
      });
    lifetime.signal.throwIfAborted();
    server = await startServer(serverOptions);
    lifetime.signal.throwIfAborted();
    log.log("info", "Daemon listening", logFields([["url", server.url]]));
    const path = join(config.dataDir, "daemon-endpoint");
    writeFileSync(path, server.httpUrl, { mode: 0o600 });
    endpointPath = path;
    // Endpoint readiness depends on the listener and core store/command port.
    // Feature activation runs under named bounds without withholding discovery.
    await startup.listening(server);
    lifetime.signal.throwIfAborted();
    initialized = true;
    return {
      ...(server.relayHostId && services.relay
        ? {
            relayHostId: server.relayHostId,
            relayFingerprint: relayFingerprint(services.relay.keys.publicKey),
          }
        : {}),
      ...(services.files ? { files: services.files } : {}),
      serviceStatus: startup.status,
      maintenance: server.maintenance,
      url: server.url,
      tokenPath,
      store,
      ...(server.remoteUrl && server.fingerprint
        ? { remoteUrl: server.remoteUrl, fingerprint: server.fingerprint }
        : {}),
      ...(server.preview ? { preview: server.preview } : {}),
      get preparePlugins() {
        return requireService(services.preparePlugins, "preparePlugins");
      },
      get launchPlugins() {
        return requireService(services.launchPlugins, "launchPlugins");
      },
      get browser() {
        return requireService(services.browser, "browser");
      },
      get context() {
        return requireService(services.context, "context");
      },
      get settings() {
        return requireService(services.settings, "settings");
      },
      engine: services.engine,
      accounts: services.accounts,
      get commands() {
        return services.commands;
      },
      get history() {
        return services.history;
      },
      get models() {
        return requireService(services.models, "models");
      },
      get notifications() {
        return requireService(services.notifications, "notifications");
      },
      get review() {
        return requireService(services.review, "review");
      },
      get mcp() {
        return requireService(services.mcp, "mcp");
      },
      close: closeResources,
    };
  } catch (error) {
    await closeResources().catch(() => {});
    throw error;
  }
}
