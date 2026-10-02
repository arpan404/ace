import { realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PluginManager, PluginService, preparePluginSession } from "@ace/plugins";
import type { Provider } from "@ace/plugins";
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
): Promise<{
  url: string;
  tokenPath: string;
  store: Store;
  preparePlugins(provider: Provider, root: string): ReturnType<typeof preparePluginSession>;
  close(): Promise<void>;
}> {
  const unlock = acquireLock(config.dataDir);
  const log = logger(config.logLevel);
  let store: Store | undefined;
  let plugins: PluginManager | undefined;
  try {
    const { token, tokenPath } = loadToken(config.dataDir);
    const hostId = loadHostId(config.dataDir);
    store = new Store(join(config.dataDir, "events.sqlite"), (error) =>
      log("error", "Event subscriber failed", error),
    );
    const ownedStore = store;
    plugins = await PluginManager.open({
      root: join(await realpath(config.dataDir), "plugins"),
      now: Date.now,
      id: randomUUID,
    });
    const ownedPlugins = plugins;
    const server = await startServer({
      port: config.port,
      token,
      hostId,
      store,
      handler,
      plugins: new PluginService(plugins),
      log: (error) => log("error", "WebSocket failure", error),
    });
    let closing: Promise<void> | undefined;
    return {
      url: server.url,
      tokenPath,
      store,
      preparePlugins: (provider, root) => preparePluginSession(ownedPlugins, provider, root),
      close() {
        closing ??= (async () => {
          try {
            await server.close();
          } finally {
            try {
              ownedPlugins.close();
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
      plugins?.close();
      store?.close();
    } finally {
      unlock();
    }
    throw error;
  }
}
