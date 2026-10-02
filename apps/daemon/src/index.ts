import { randomUUID } from "node:crypto";
import { ContextService } from "@ace/context";
import { ThreadId } from "@ace/protocol";
import { writeFileSync, unlinkSync } from "node:fs";
import { remoteListener } from "./network.ts";
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
  context: ContextService;
  remoteUrl?: string;
  fingerprint?: string;
  close(): Promise<void>;
}> {
  const unlock = acquireLock(config.dataDir);
  const log = logger(config.logLevel);
  let store: Store | undefined;
  let context: ContextService | undefined;
  try {
    const { token, tokenPath } = loadToken(config.dataDir);
    const hostId = loadHostId(config.dataDir);
    store = new Store(join(config.dataDir, "events.sqlite"), (error) =>
      log("error", "Event subscriber failed", error),
    );
    const ownedStore = store;
    context = await ContextService.open({
      root: join(config.dataDir, "context"),
      now: Date.now,
      id: randomUUID,
      authorize: (_device, thread) => ownedStore.getThread(ThreadId.parse(thread)) !== undefined,
      workspace: (thread) => {
        const entity = ownedStore.getThread(ThreadId.parse(thread));
        return entity ? ownedStore.getWorkspacePath(entity.workspaceId) : undefined;
      },
    });
    const ownedContext = context;
    const remote = await remoteListener(config);
    const server = await startServer({
      context,
      ...(remote ? { remote } : {}),
      port: config.port,
      token,
      hostId,
      store,
      handler,
      log: (error) => log("error", "WebSocket failure", error),
    });
    const endpointPath = join(config.dataDir, "daemon-endpoint");
    try {
      writeFileSync(endpointPath, server.httpUrl, { mode: 0o600 });
    } catch (error) {
      await server.close();
      throw error;
    }
    let maintaining = false;
    const maintain = () => {
      if (maintaining) return;
      maintaining = true;
      void ownedContext.uploads
        .collect()
        .catch((error: unknown) => log("error", "Attachment maintenance failed", error))
        .finally(() => {
          maintaining = false;
        });
    };
    maintain();
    const maintenance = setInterval(maintain, 60_000);
    maintenance.unref();
    let closing: Promise<void> | undefined;
    return {
      url: server.url,
      ...(server.remoteUrl && server.fingerprint
        ? { remoteUrl: server.remoteUrl, fingerprint: server.fingerprint }
        : {}),
      tokenPath,
      store,
      context: ownedContext,
      close() {
        closing ??= (async () => {
          try {
            clearInterval(maintenance);
            await server.close();
          } finally {
            try {
              await ownedContext.close();
              ownedStore.close();
            } finally {
              try {
                unlinkSync(endpointPath);
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
      await context?.close();
      store?.close();
    } finally {
      unlock();
    }
    throw error;
  }
}
