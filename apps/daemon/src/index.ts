import { writeFileSync, unlinkSync } from "node:fs";
import { remoteListener } from "./network.ts";
import { startDaemonMcp } from "./mcp.ts";
import type { Toolkit } from "@ace/mcp-server";
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
  toolkits: readonly Toolkit[] = [],
  browserOptions: Omit<BrowserServiceOptions, "dataDir" | "onArtifact"> = {},
): Promise<{
  url: string;
  tokenPath: string;
  store: Store;
  browser: BrowserService;
  mcp: Awaited<ReturnType<typeof startDaemonMcp>>;
  remoteUrl?: string;
  fingerprint?: string;
  close(): Promise<void>;
}> {
  const unlock = acquireLock(config.dataDir);
  const log = logger(config.logLevel);
  let store: Store | undefined;
  let browser: BrowserService | undefined;
  let mcp: Awaited<ReturnType<typeof startDaemonMcp>> | undefined;
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
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
      browser,
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
      browser,
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
                  await ownedBrowser.close();
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
            await browser?.close();
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
