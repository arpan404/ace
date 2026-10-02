import type { ModelCatalog, InstanceInput } from "@ace/models";
import { openDaemonModels } from "./models.ts";
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
  modelInstances: readonly InstanceInput[] = [],
): Promise<{
  url: string;
  tokenPath: string;
  store: Store;
  models: ModelCatalog;
  close(): Promise<void>;
}> {
  const unlock = acquireLock(config.dataDir);
  const log = logger(config.logLevel);
  let store: Store | undefined;
  let models: ModelCatalog | undefined;
  try {
    const { token, tokenPath } = loadToken(config.dataDir);
    const hostId = loadHostId(config.dataDir);
    store = new Store(join(config.dataDir, "events.sqlite"), (error) =>
      log("error", "Event subscriber failed", error),
    );
    const ownedStore = store;
    models = openDaemonModels(config.dataDir, modelInstances);
    const ownedModels = models;
    const server = await startServer({
      port: config.port,
      token,
      hostId,
      store,
      handler,
      models,
      log: (error) => log("error", "WebSocket failure", error),
    });
    let closing: Promise<void> | undefined;
    return {
      url: server.url,
      tokenPath,
      store,
      models,
      close() {
        closing ??= (async () => {
          try {
            await server.close();
          } finally {
            try {
              try {
                await ownedModels.close();
              } finally {
                ownedStore.close();
              }
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
      try {
        await models?.close();
      } finally {
        store?.close();
      }
    } finally {
      unlock();
    }
    throw error;
  }
}
