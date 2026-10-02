import { FilesService } from "@ace/files";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
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
  files?: FilesService;
  remoteUrl?: string;
  fingerprint?: string;
  close(): Promise<void>;
}> {
  const unlock = acquireLock(config.dataDir);
  const log = logger(config.logLevel);
  let store: Store | undefined;
  let files: FilesService | undefined;
  let maintenance: ReturnType<typeof setInterval> | undefined;
  try {
    const { token, tokenPath } = loadToken(config.dataDir);
    const hostId = loadHostId(config.dataDir);
    store = new Store(join(config.dataDir, "events.sqlite"), (error) =>
      log("error", "Event subscriber failed", error),
    );
    const ownedStore = store;
    if (config.workspaceRoot) {
      const artifacts = join(config.dataDir, "artifacts");
      await mkdir(artifacts, { recursive: true, mode: 0o700 });
      files = await FilesService.create({
        workspace: config.workspaceRoot,
        dataDir: join(config.dataDir, "files"),
        artifactRoots: [artifacts],
        now: Date.now,
        id: randomUUID,
        // Socket-scoped read/operate checks are enforced by the authenticated server.
        authorize: () => true,
      });
      await files.sweep();
      const ownedFiles = files;
      maintenance = setInterval(() => {
        void ownedFiles
          .sweep()
          .catch((error: unknown) => log("error", "File retention failed", error));
      }, 60_000);
      maintenance.unref();
    }
    const remote = await remoteListener(config);
    const server = await startServer({
      ...(remote ? { remote } : {}),
      port: config.port,
      token,
      hostId,
      store,
      handler,
      ...(files ? { files } : {}),
      log: (error) => log("error", "WebSocket failure", error),
    });
    const endpointPath = join(config.dataDir, "daemon-endpoint");
    try {
      writeFileSync(endpointPath, server.httpUrl, { mode: 0o600 });
    } catch (error) {
      await server.close();
      throw error;
    }
    let closing: Promise<void> | undefined;
    return {
      url: server.url,
      ...(server.remoteUrl && server.fingerprint
        ? { remoteUrl: server.remoteUrl, fingerprint: server.fingerprint }
        : {}),
      tokenPath,
      store,
      ...(files ? { files } : {}),
      close() {
        closing ??= (async () => {
          try {
            await server.close();
          } finally {
            try {
              if (maintenance) clearInterval(maintenance);
              await files?.close();
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
      if (maintenance) clearInterval(maintenance);
      await files?.close();
      store?.close();
    } finally {
      unlock();
    }
    throw error;
  }
}
