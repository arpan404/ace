import { homedir } from "node:os";
import { createRedactor } from "@ace/redaction";
import {
  createFileSink,
  createLogger,
  createHealthMonitor,
  type HealthOptions,
} from "@ace/diagnostics";
import { writeFileSync, unlinkSync } from "node:fs";
import { remoteListener } from "./network.ts";
import { join } from "node:path";
import { type CommandHandler, stubHandler } from "./commands.ts";
import { type Config, readConfig } from "./config.ts";
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
export async function startDaemon(
  config: Config = readConfig(),
  handler: CommandHandler = stubHandler(),
  workload: HealthOptions["workload"] = () => ({ activeSessions: null, queues: {} }),
): Promise<{
  url: string;
  tokenPath: string;
  store: Store;
  remoteUrl?: string;
  fingerprint?: string;
  close(): Promise<void>;
}> {
  const unlock = acquireLock(config.dataDir);
  const context = { home: homedir(), env: process.env };
  let log: ReturnType<typeof createLogger> | undefined;
  let health: ReturnType<typeof createHealthMonitor> | undefined;
  let store: Store | undefined;
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
      workload,
      logs: ownedLog.stats,
    });
    const ownedHealth = health;
    const { token, tokenPath } = loadToken(config.dataDir);
    const hostId = loadHostId(config.dataDir);
    store = new Store(join(config.dataDir, "events.sqlite"), (error) =>
      ownedLog.child("store").log("error", "Event subscriber failed", error),
    );
    const ownedStore = store;
    const remote = await remoteListener(config);
    const server = await startServer({
      ...(remote ? { remote } : {}),
      port: config.port,
      token,
      hostId,
      store,
      handler,
      health: ownedHealth.collect,
      log: (error) => ownedLog.child("websocket").log("error", "WebSocket failure", error),
    });
    ownedLog.log("info", "Daemon listening", { url: server.url });
    const endpointPath = join(config.dataDir, "daemon-endpoint");
    try {
      writeFileSync(endpointPath, server.httpUrl, { mode: 0o600 });
    } catch (error) {
      await server.close();
      throw error;
    }
    let closing: Promise<void> | undefined;
    return {
      url: server.url,
      ...(server.remoteUrl && server.fingerprint
        ? { remoteUrl: server.remoteUrl, fingerprint: server.fingerprint }
        : {}),
      tokenPath,
      store,
      close() {
        closing ??= (async () => {
          try {
            await server.close();
          } finally {
            try {
              ownedStore.close();
            } finally {
              ownedHealth.close();
              try {
                await ownedLog.close();
              } finally {
                try {
                  unlinkSync(endpointPath);
                } finally {
                  unlock();
                }
              }
            }
          }
        })();
        return closing;
      },
    };
  } catch (error) {
    try {
      store?.close();
    } finally {
      health?.close();
      try {
        await log?.close();
      } finally {
        unlock();
      }
    }
    throw error;
  }
}
