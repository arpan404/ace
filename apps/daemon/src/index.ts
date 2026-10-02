import { supportBundleWriter } from "./files-support.ts";
import { daemonArtifacts } from "./files-artifacts.ts";
import { loadOrCreateHostKeys } from "@ace/secure-channel/node";
import { fingerprint as relayFingerprint } from "@ace/secure-channel";
import { FilesService } from "@ace/files";
import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { createRedactor } from "@ace/redaction";
import {
  logFields,
  createFileSink,
  createLogger,
  createHealthMonitor,
  type HealthOptions,
} from "@ace/diagnostics";
import type { ModelCatalog, InstanceInput } from "@ace/models";
import { openDaemonModels } from "./models.ts";
import { writeFileSync, unlinkSync } from "node:fs";
import type { NotificationWorker, NotificationChannels } from "@ace/notify";
import type { Toolkit } from "@ace/mcp-server";
import { basename, join } from "node:path";
import { remoteListener } from "./network.ts";
import { startDaemonMcp } from "./mcp.ts";
import { loadNotificationChannels } from "./notification-config.ts";
import { createDaemonNotifications, type DaemonNotifications } from "./notifications.ts";
import { type CommandHandler, stubHandler } from "./commands.ts";
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

export async function startDaemon(
  config: Config = readConfig(),
  handler: CommandHandler = stubHandler(),
  toolkits: readonly Toolkit[] = [],
  notificationChannels?: Omit<NotificationChannels, "websocket">,
  modelInstances: readonly InstanceInput[] = [],
  workload: HealthOptions["workload"] = () => ({ activeSessions: null, queues: {} }),
): Promise<{
  url: string;
  tokenPath: string;
  store: Store;
  files?: FilesService;
  models: ModelCatalog;
  notifications: NotificationWorker;
  mcp: Awaited<ReturnType<typeof startDaemonMcp>>;
  remoteUrl?: string;
  fingerprint?: string;
  relayHostId?: string;
  relayFingerprint?: string;
  close(): Promise<void>;
}> {
  const unlock = acquireLock(config.dataDir);
  const context = { home: homedir(), env: process.env };
  let log: ReturnType<typeof createLogger> | undefined;
  let health: ReturnType<typeof createHealthMonitor> | undefined;
  let store: Store | undefined;
  let files: FilesService | undefined;
  let artifacts: ReturnType<typeof daemonArtifacts> | undefined;
  let maintenance: ReturnType<typeof setInterval> | undefined;
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
          await notifications?.close();
        } finally {
          try {
            closeChannels();
          } finally {
            try {
              if (maintenance) clearInterval(maintenance);
              try {
                try {
                  await files?.close();
                } finally {
                  try {
                    await artifacts?.close();
                  } finally {
                    await models?.close();
                  }
                }
              } finally {
                store?.close();
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
      context,
    }).catch(() => ({
      async write() {
        throw new Error("File logging unavailable");
      },
      async close() {},
    }));
    log = createLogger({
      sink,
      now: Date.now,
      redact: createRedactor(context),
      level: config.logLevel,
    });
    const ownedLog = log;
    health = createHealthMonitor({
      database: join(config.dataDir, "events.sqlite"),
      now: Date.now,
      workload: () => {
        const engine = workload();
        return {
          ...engine,
          queues: {
            ...engine.queues,
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
    if (config.relayUrl && !config.workspaceRoot)
      throw new Error("Relay files require ACE_WORKSPACE_ROOT");
    if (config.workspaceRoot) {
      const eventStore = store;
      const workspaceRoot = await realpath(config.workspaceRoot);
      const workspaceId = store.createWorkspace(workspaceRoot, basename(workspaceRoot));
      const artifactsDirectory = join(config.dataDir, "artifacts");
      await mkdir(artifactsDirectory, { recursive: true, mode: 0o700 });
      const artifactsRoot = await realpath(artifactsDirectory);
      files = await FilesService.create({
        workspace: workspaceRoot,
        dataDir: join(config.dataDir, "files"),
        artifactRoots: [artifactsRoot],
        now: Date.now,
        id: randomUUID,
        // Socket-scoped read/operate checks are enforced by the authenticated server.
        authorize: () => true,
        onChange: (change) => eventStore.recordWorkspaceFileChange(workspaceId, change),
        exportSupport: (_device, assertAuthorized) => {
          if (!artifacts) throw new Error("Artifact producer not initialized");
          return artifacts.bundle(assertAuthorized);
        },
        exportRaw: (_device, blobRef, assertAuthorized) => {
          if (!artifacts) throw new Error("Artifact producer not initialized");
          return artifacts.raw(blobRef, assertAuthorized);
        },
        exportOutput: (_device, streamId, assertAuthorized) => {
          if (!artifacts) throw new Error("Artifact producer not initialized");
          return artifacts.output(streamId, assertAuthorized);
        },
      });
      await files.sweep();
      artifacts = daemonArtifacts(
        files,
        artifactsRoot,
        store,
        workspaceId,
        join(config.dataDir, "events.sqlite"),
        supportBundleWriter(
          config.dataDir,
          artifactsRoot,
          { ...context, workspace: workspaceRoot },
          Date.now,
        ),
      );
      await artifacts.support(hostId);
      const ownedFiles = files;
      maintenance = setInterval(() => {
        void ownedFiles
          .sweep()
          .catch((error: unknown) => ownedLog.log("error", "File retention failed", error));
      }, 60_000);
      maintenance.unref();
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
      () => ownedLog.log("error", "Notification service failure"),
      configured.channels,
    );
    const remote = await remoteListener(config);
    const relayKeys = config.relayUrl
      ? await loadOrCreateHostKeys(join(config.dataDir, "relay"))
      : undefined;
    server = await startServer({
      ...(config.relayUrl && relayKeys ? { relay: { url: config.relayUrl, keys: relayKeys } } : {}),
      ...(remote ? { remote } : {}),
      port: config.port,
      token,
      hostId,
      store,
      handler,
      ...(files ? { files } : {}),
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
    let closing: Promise<void> | undefined;
    return {
      url: server.url,
      ...(server.remoteUrl && server.fingerprint
        ? { remoteUrl: server.remoteUrl, fingerprint: server.fingerprint }
        : {}),
      ...(server.relayHostId && relayKeys
        ? {
            relayHostId: server.relayHostId,
            relayFingerprint: relayFingerprint(relayKeys.publicKey),
          }
        : {}),
      tokenPath,
      store,
      ...(files ? { files } : {}),
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
