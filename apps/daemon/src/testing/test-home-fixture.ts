import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type DaemonOptions } from "../index.ts";

export type RegisterCleanup = (cleanup: () => void | Promise<void>) => void;

export async function testHomes(cleanup: RegisterCleanup) {
  const root = await mkdtemp(join(tmpdir(), "ace-protected-homes-"));
  cleanup(() => rm(root, { recursive: true, force: true }));
  const protectedHome = join(root, "owner"),
    safeHome = join(root, "owner-other");
  await mkdir(protectedHome);
  await mkdir(safeHome);
  return { root, protectedHome, safeHome };
}

/** Failed rejection assertions must still own a daemon that unexpectedly starts. */
export function ownedDaemonAttempt(cleanup: RegisterCleanup, options: DaemonOptions) {
  return startDaemon(options).then((daemon) => {
    cleanup(() => daemon.close());
    return daemon;
  });
}

export function daemonConfig(dataDir: string) {
  return {
    dataDir,
    host: "127.0.0.1" as const,
    port: 0,
    remotePort: 0,
    listen: "local" as const,
    logLevel: "silent" as const,
  };
}
