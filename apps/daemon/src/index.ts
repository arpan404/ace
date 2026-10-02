import { join } from "node:path";
import { localScreenManager, type ScreenManager } from "@ace/screen";
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
  screen?: ScreenManager,
): Promise<{ url: string; tokenPath: string; store: Store; close(): Promise<void> }> {
  const unlock = acquireLock(config.dataDir);
  const log = logger(config.logLevel);
  let store: Store | undefined;
  try {
    const { token, tokenPath } = loadToken(config.dataDir);
    const hostId = loadHostId(config.dataDir);
    store = new Store(join(config.dataDir, "events.sqlite"), (error) =>
      log("error", "Event subscriber failed", error),
    );
    const ownedStore = store;
    screen ??= config.screenHelper
      ? localScreenManager(config.screenHelper, join(config.dataDir, "screen-artifacts"))
      : undefined;
    const server = await startServer({
      port: config.port,
      token,
      hostId,
      store,
      handler,
      ...(screen ? { screen } : {}),
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
            await screen?.close();
          } finally {
            try {
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
      store?.close();
    } finally {
      unlock();
    }
    throw error;
  }
}
