import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { BrowserService, type BrowserServiceOptions } from "@ace/browser";
import { ItemId, ThreadId } from "@ace/protocol";
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
  browserOptions: Omit<BrowserServiceOptions, "dataDir" | "onArtifact"> = {},
): Promise<{
  url: string;
  tokenPath: string;
  store: Store;
  browser: BrowserService;
  close(): Promise<void>;
}> {
  const unlock = acquireLock(config.dataDir);
  const log = logger(config.logLevel);
  let store: Store | undefined;
  let browser: BrowserService | undefined;
  try {
    const { token, tokenPath } = loadToken(config.dataDir);
    const hostId = loadHostId(config.dataDir);
    store = new Store(join(config.dataDir, "events.sqlite"), (error) =>
      log("error", "Event subscriber failed", error),
    );
    const ownedStore = store;
    browser = new BrowserService({
      ...browserOptions,
      dataDir: config.dataDir,
      onArtifact: (rawThreadId, artifact) => {
        const threadId = ThreadId.parse(rawThreadId);
        const thread = ownedStore.getThread(threadId);
        if (!thread) throw new Error("Recording thread no longer exists");
        ownedStore.appendEvents(threadId, [
          {
            type: "item.created",
            item: {
              type: "artifact",
              id: ItemId.parse(randomUUID()),
              ...(thread.rootAgentId ? { agentId: thread.rootAgentId } : {}),
              createdAt: Date.now(),
              complete: true,
              source: "browser",
              ...artifact,
            },
          },
        ]);
      },
    });
    const ownedBrowser = browser;
    const server = await startServer({
      port: config.port,
      token,
      hostId,
      store,
      handler,
      browser,
      log: (error) => log("error", "WebSocket failure", error),
    });
    let closing: Promise<void> | undefined;
    return {
      url: server.url,
      tokenPath,
      store,
      browser,
      close() {
        closing ??= (async () => {
          try {
            await server.close();
          } finally {
            try {
              await ownedBrowser.close();
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
      try {
        await browser?.close();
      } finally {
        store?.close();
      }
    } finally {
      unlock();
    }
    throw error;
  }
}
