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
import { startServer } from "./server.ts";
import { Store } from "./store.ts";
import { Resources } from "./services/resources.ts";
import { serviceFactories, readyServices, type ServiceContext } from "./services/composition.ts";
import type { DaemonOptions } from "./services/options.ts";
export type { DaemonOptions } from "./services/options.ts";
export { Engine, AdapterRegistry, type EngineOptions, type EngineClock } from "./engine/index.ts";
export { Store, type StoreOptions } from "./store.ts";
export { readConfig } from "./config.ts";
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
  const config = options.config ?? readConfig();
  const unlock = acquireLock(config.dataDir);
  const resources = new Resources();
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let endpointPath: string | undefined;
  const closeResources = async () => {
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
    const serviceContext: ServiceContext = {
      config,
      options,
      now: Date.now,
      id: randomUUID,
      log,
      resources,
      services: {},
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
    for (const factory of serviceFactories) await factory(serviceContext);
    const services = readyServices(serviceContext.services);
    const { token, tokenPath } = loadToken(config.dataDir);
    const hostId = loadHostId(config.dataDir);
    const remote = await remoteListener(config);
    server = await startServer({
      ...services,
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
    });
    log.log("info", "Daemon listening", logFields([["url", server.url]]));
    for (const start of serviceContext.onListen) await start(server);
    const path = join(config.dataDir, "daemon-endpoint");
    writeFileSync(path, server.httpUrl, { mode: 0o600 });
    endpointPath = path;
    let closing: Promise<void> | undefined;
    return {
      ...(server.relayHostId && services.relay
        ? {
            relayHostId: server.relayHostId,
            relayFingerprint: relayFingerprint(services.relay.keys.publicKey),
          }
        : {}),
      ...(services.files ? { files: services.files } : {}),
      maintenance: server.maintenance,
      url: server.url,
      tokenPath,
      store,
      ...(server.remoteUrl && server.fingerprint
        ? { remoteUrl: server.remoteUrl, fingerprint: server.fingerprint }
        : {}),
      ...(server.preview ? { preview: server.preview } : {}),
      preparePlugins: services.preparePlugins,
      launchPlugins: services.launchPlugins,
      browser: services.browser,
      context: services.context,
      settings: services.settings,
      models: services.models,
      notifications: services.notifications,
      review: services.review,
      mcp: services.mcp,
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
