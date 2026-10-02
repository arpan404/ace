import { Engine, type EngineOptions } from "./engine/index.ts";
export { Engine, AdapterRegistry, type EngineOptions, type EngineClock } from "./engine/index.ts";
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
export async function startDaemon(
  config: Config = readConfig(),
  handler?: CommandHandler,
  engineOptions: EngineOptions = {},
): Promise<{ url: string; tokenPath: string; store: Store; close(): Promise<void> }> {
  const unlock = acquireLock(config.dataDir);
  const log = logger(config.logLevel);
  let store: Store | undefined;
  let engine: Engine | undefined;
  try {
    const { token, tokenPath } = loadToken(config.dataDir);
    const hostId = loadHostId(config.dataDir);
    store = new Store(join(config.dataDir, "events.sqlite"), (error) =>
      log("error", "Event subscriber failed", error),
    );
    const ownedStore = store;
    if (!handler) {
      engine = new Engine(store, engineOptions);
      handler = engine.handler;
    }
    const server = await startServer({
      port: config.port,
      token,
      hostId,
      store,
      handler,
      log: (error) => log("error", "WebSocket failure", error),
    });
    let closing: Promise<void> | undefined;
    return {
      url: server.url,
      tokenPath,
      store,
      close() {
        closing ??= (async () => {
          try {
            await server.close();
          } finally {
            try {
              await engine?.close();
              ownedStore.close();
            } finally {
              unlock();
            }
          }
        })();
        return closing;
      },
    };
  } catch (error) {
    try {
      await engine?.close();
      store?.close();
    } finally {
      unlock();
    }
    throw error;
  }
}
