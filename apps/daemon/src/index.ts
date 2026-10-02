import { AccountService, openRegistry } from "@ace/accounts";
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
): Promise<{ url: string; tokenPath: string; store: Store; close(): Promise<void> }> {
  const unlock = acquireLock(config.dataDir);
  const log = logger(config.logLevel);
  let store: Store | undefined;
  let registry: Awaited<ReturnType<typeof openRegistry>> | undefined;
  try {
    const { token, tokenPath } = loadToken(config.dataDir);
    const hostId = loadHostId(config.dataDir);
    store = new Store(join(config.dataDir, "events.sqlite"), (error) =>
      log("error", "Event subscriber failed", error),
    );
    registry = await openRegistry(
      process.env["ACE_ACCOUNTS_DB"] ?? join(config.dataDir, "accounts.sqlite"),
    );
    const ownedRegistry = registry;
    const accounts = new AccountService({
      registry,
      now: Date.now,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      env: process.env,
    });
    const ownedStore = store;
    const server = await startServer({
      port: config.port,
      token,
      hostId,
      store,
      handler,
      accounts,
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
              ownedStore.close();
            } finally {
              try {
                ownedRegistry.close();
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
      try {
        store?.close();
      } finally {
        registry?.close();
      }
    } finally {
      unlock();
    }
    throw error;
  }
}
