import { Engine, type EngineOptions } from "./engine/index.ts";
export { Engine, AdapterRegistry, type EngineOptions, type EngineClock } from "./engine/index.ts";
import { writeFileSync, unlinkSync } from "node:fs";
import { remoteListener } from "./network.ts";
import { startDaemonMcp } from "./mcp.ts";
import type { Toolkit } from "@ace/mcp-server";
import { join } from "node:path";
import { type CommandHandler } from "./commands.ts";
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
const isToolkitList = (input: EngineOptions | readonly Toolkit[]): input is readonly Toolkit[] =>
  Array.isArray(input);
export async function startDaemon(
  config: Config = readConfig(),
  handler?: CommandHandler,
  options: EngineOptions | readonly Toolkit[] = {},
  mcpToolkits: readonly Toolkit[] = [],
): Promise<{
  url: string;
  tokenPath: string;
  store: Store;
  mcp: Awaited<ReturnType<typeof startDaemonMcp>>;
  remoteUrl?: string;
  fingerprint?: string;
  close(): Promise<void>;
}> {
  const engineOptions = isToolkitList(options) ? {} : options;
  const toolkits = isToolkitList(options) ? options : mcpToolkits;
  const unlock = acquireLock(config.dataDir);
  const log = logger(config.logLevel);
  let store: Store | undefined;
  let engine: Engine | undefined;
  let mcp: Awaited<ReturnType<typeof startDaemonMcp>> | undefined;
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    const { token, tokenPath } = loadToken(config.dataDir);
    const hostId = loadHostId(config.dataDir);
    store = new Store(join(config.dataDir, "events.sqlite"), (error) =>
      log("error", "Event subscriber failed", error),
    );
    const ownedStore = store;
    if (!handler) {
      engine = new Engine(store, {
        ...engineOptions,
        onError: engineOptions.onError ?? ((error) => log("error", "Engine failure", error)),
      });
      handler = engine.handler;
    }
    mcp = await startDaemonMcp(store, toolkits);
    const ownedMcp = mcp;
    const remote = await remoteListener(config);
    server = await startServer({
      ...(remote ? { remote } : {}),
      port: config.port,
      token,
      hostId,
      store,
      handler,
      log: (error) => log("error", "WebSocket failure", error),
    });
    const ownedServer = server;
    const endpointPath = join(config.dataDir, "daemon-endpoint");
    writeFileSync(endpointPath, server.httpUrl, { mode: 0o600 });
    let closing: Promise<void> | undefined;
    return {
      url: server.url,
      ...(server.remoteUrl && server.fingerprint
        ? { remoteUrl: server.remoteUrl, fingerprint: server.fingerprint }
        : {}),
      tokenPath,
      store,
      mcp: ownedMcp,
      close() {
        closing ??= (async () => {
          try {
            await ownedMcp.close();
          } finally {
            try {
              await ownedServer.close();
            } finally {
              try {
                try {
                  await engine?.close();
                } finally {
                  ownedStore.close();
                }
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
      await mcp?.close();
    } finally {
      try {
        await server?.close();
      } finally {
        try {
          try {
            await engine?.close();
          } finally {
            store?.close();
          }
        } finally {
          unlock();
        }
      }
    }
    throw error;
  }
}
