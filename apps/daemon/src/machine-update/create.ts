import type { AppUpdateBoard } from "../app-update-board.ts";
import type { ServerOptions } from "../server-options.ts";
import type { Store } from "../store.ts";
import { watchBusy } from "./busy.ts";
import { desktopInstaller } from "./desktop-installer.ts";
import { sourceInstaller, type Installer } from "./installer.ts";
import { MachineUpdates } from "./machine-updates.ts";
import { standaloneInstaller } from "./standalone-installer.ts";

/** The server's machine updates from its options, started; undefined when it has none. */
export async function createMachineUpdates(input: {
  config: NonNullable<ServerOptions["machineUpdate"]>;
  version: string;
  board: AppUpdateBoard;
  store: Pick<Store, "subscribe">;
  busy(): number;
  runtime: { now(): number; id(): string; delay(callback: () => void, ms: number): () => void };
  log(error: unknown): void;
}): Promise<MachineUpdates> {
  const { config, runtime } = input;
  const installer: Installer =
    config.install === "desktop"
      ? desktopInstaller(input.board, runtime)
      : config.install === "standalone" && config.updater
        ? standaloneInstaller({
            version: input.version,
            ports: config.updater,
            clock: runtime,
            log: input.log,
          })
        : sourceInstaller();
  const updates = new MachineUpdates({
    installer,
    record: config.record,
    version: input.version,
    platform: config.platform ?? process.platform,
    arch: config.arch ?? process.arch,
    busy: input.busy,
    watchBusy: (listener) => watchBusy(input.store, runtime, listener),
    now: runtime.now,
    id: runtime.id,
    log: input.log,
  });
  await updates.start();
  return updates;
}
