import { startDaemonMcp } from "./mcp.ts";
import type { Toolkit } from "@ace/mcp-server";
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
export async function startDaemon(
  config: Config = readConfig(),
  handler: CommandHandler = stubHandler(),
  toolkits: readonly Toolkit[] = [],
) {
  const unlock = acquireLock(config.dataDir);
  const log = logger(config.logLevel);
  let store: Store | undefined;
  let mcp: Awaited<ReturnType<typeof startDaemonMcp>> | undefined;
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    const { token, tokenPath } = loadToken(config.dataDir);
    const hostId = loadHostId(config.dataDir);
    store = new Store(join(config.dataDir, "events.sqlite"), (error) =>
      log("error", "Event subscriber failed", error),
    );
    const ownedStore = store;
    mcp = await startDaemonMcp(store, toolkits);
    const ownedMcp = mcp;
    server = await startServer({
      port: config.port,
      token,
      hostId,
      store,
      handler,
      log: (error) => log("error", "WebSocket failure", error),
    });
    const ownedServer = server;
    let closing: Promise<void> | undefined;
    return {
      url: server.url,
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
                ownedStore.close();
              } finally {
                unlock();
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
          store?.close();
        } finally {
          unlock();
        }
      }
    }
    throw error;
  }
}
