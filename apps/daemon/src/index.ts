import { SettingsService } from "@ace/settings";
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
  settings: SettingsService;
  close(): Promise<void>;
}> {
  const unlock = acquireLock(config.dataDir);
  const log = logger(config.logLevel);
  let store: Store | undefined;
  let settings: SettingsService | undefined;
  try {
    const { token, tokenPath } = loadToken(config.dataDir);
    const hostId = loadHostId(config.dataDir);
    store = new Store(join(config.dataDir, "events.sqlite"), (error) =>
      log("error", "Event subscriber failed", error),
    );
    const ownedStore = store;
    settings = new SettingsService({ dataDir: config.dataDir });
    const ownedSettings = settings;
    const server = await startServer({
      settings,
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
      settings,
      close() {
        closing ??= (async () => {
          try {
            await server.close();
          } finally {
            try {
              await ownedSettings.close();
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
      await settings?.close();
      store?.close();
    } finally {
      unlock();
    }
    throw error;
  }
}
