export { runDaemonProcess } from "./process-daemon.ts";
export { createDaemonCommandLibrary } from "./command-library.ts";
export { connectDaemonCommandEvents, type CommandEventSource } from "./command-events.ts";
export type { DaemonCommandIntegration } from "./services/commands.ts";
import { assertCompatibleHome, assertTestHomeIsolation } from "@ace/service";
import { assertTestEnvironmentIsolation } from "@ace/provider-kit/test-isolation";
import { assertModelTestIsolation } from "./models.ts";
import { fingerprint as relayFingerprint } from "@ace/secure-channel";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createRedactor } from "@ace/redaction";
import {
  logError,
  logFields,
  createFileSink,
  createLogger,
  createHealthMonitor,
} from "@ace/diagnostics";
import { readConfig } from "./config.ts";
import { acquireLock, loadHostId, loadToken } from "./local-files.ts";
import { remoteListener } from "./network.ts";
import { startServer, type ServerOptions } from "./server.ts";
import { Store } from "./store.ts";
import { Resources } from "./services/resources.ts";
import {
  serviceFactories,
  requireService,
  readyServices,
  type ServiceContext,
} from "./services/composition.ts";
import { ServiceStartup, systemStartup } from "./services/startup.ts";
import type { DaemonOptions } from "./services/options.ts";
export type { DaemonOptions } from "./services/options.ts";
export { Engine, AdapterRegistry, type EngineOptions, type EngineClock } from "./engine/index.ts";
export { AgentPreviews } from "./agent-control/owners.ts";
export { DelegationService, type DelegationDependencies } from "./agent-control/delegations.ts";
export type { HandoffGit } from "./agent-control/handoffs.ts";
export {
  createAgentControlPort,
  type AgentControlExtensions,
  type ThreadOwnerOperation,
} from "./agent-control/tools.ts";
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
  const home = homedir();
  assertTestHomeIsolation(home);
  const clock = options.engine?.clock;
  const now = clock ? () => clock.now() : Date.now;
  const config = options.config ?? readConfig();
  assertCompatibleHome(config.dataDir);
  // Reject test path escapes before optional-service failures can be downgraded to degraded startup.
  if (process.env.ACE_TEST_REAL_HOME) {
    // The home boundary above owns ambient HOME; this check owns other path selectors.
    assertTestEnvironmentIsolation({ ...process.env, HOME: undefined, USERPROFILE: undefined });
    for (const instance of options.history?.instances ?? [])
      assertTestHomeIsolation(instance.homeDir);
    assertModelTestIsolation(options.modelInstances ?? []);
  }
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
    const context = { home, env: process.env };
    const logDirectory = join(config.dataDir, "logs");
    const sink = await createFileSink({
      directory: logDirectory,
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
      now,
      redact: createRedactor(context),
      level: config.logLevel,
    });
    resources.own(() => log.close());
    lifetime.signal.throwIfAborted();
    const serviceContext: ServiceContext = {
      signal: lifetime.signal,
      config,
      options,
      now,
      id: randomUUID,
      log,
      resources,
      services: {
        handler: {
          handle: (command) => ({ commandId: command.id, ok: false, error: "engine_unavailable" }),
        },
      },
      onListen: [],
      store: new Store(
        join(config.dataDir, "events.sqlite"),
        (error) => log.log("error", "Event subscriber failed", logError(error)),
        { now },
      ),
    };
    const store = serviceContext.store;
    resources.own(() => store.close());
    const health = createHealthMonitor({
      database: join(config.dataDir, "events.sqlite"),
      now,
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
      logs: () => ({ ...log.stats(), directory: logDirectory }),
    });
    resources.own(() => health.close());
    const startup = new ServiceStartup(serviceContext, { ...systemStartup, ...options.startup });
    await startup.start(serviceFactories);
    const services = serviceContext.services;
    readyServices(services);
    const handler = services.handler;
    const { token, tokenPath } = loadToken(config.dataDir);
    const hostId = loadHostId(config.dataDir);
    const remote = await remoteListener(config);
    const socketReady = Promise.withResolvers<void>();
    resources.onShutdown(() => socketReady.resolve());
    const serverOptions: ServerOptions = {
      ...services,
      get commands() {
        return services.commands;
      },
      handler,
      serviceStatus: startup.status,
      ready: socketReady.promise,
      ...(remote ? { remote } : {}),
      maintenance: process.env.ACE_MAINTENANCE === "1",
      version: process.env.ACE_VERSION ?? "development",
      port: config.port,
      ...(config.webOrigins ? { webOrigins: config.webOrigins } : {}),
      token,
      hostId,
      store,
      ...(options.preview ? { preview: options.preview } : {}),
      health: health.collect,
      log: (error) => log.log("error", "WebSocket failure", logError(error)),
    };
    // Feature services publish only after initialization. Socket handlers read the
    // live registry, so a service can become available after endpoint discovery.
    for (const key of [
      "screen",
      "accounts",
      "accountManagement",
      "cursorAuth",
      "providerActivation",
      "commands",
      "files",
      "threadFiles",
      "relay",
      "handler",
      "plugins",
      "browser",
      "context",
      "settings",
      "models",
      "providerStatuses",
      "mcp",
      "notifications",
      "review",
      "history",
      "usage",
      "agentRegistry",
      "pi",
      "engine",
      "transitions",
      "workspaceActions",
      "projects",
      "canReadThread",
      "previewClient",
      "conductor",
      "automations",
      "activityReads",
      "devices",
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
    queueMicrotask(() => socketReady.resolve());
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
      get devices() {
        return services.devices;
      },
      engine: services.engine,
      conductor: services.conductor,
      agentControl: services.agentControl,
      accounts: services.accounts,
      accountManagement: services.accountManagement,
      cursorAuth: services.cursorAuth,
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
