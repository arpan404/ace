import { detectToolchains } from "@ace/diagnostics";
import { join } from "node:path";
import {
  managedServeSim,
  pinnedServeSim,
  serveSimStatus,
  type ServeSimStatus,
} from "@ace/devices/tools";
import { spawnRawSupervised } from "@ace/provider-kit/process";
import type { Toolchain } from "@ace/protocol";

/** How serve-sim, which streams the iOS Simulator, reads in the toolchain list. */
export function serveSimToolchain(status: ServeSimStatus): Toolchain {
  return {
    id: "serve-sim",
    available: status.supported,
    detail: status.command
      ? `serve-sim ${status.version ?? "(unknown version)"}${status.source === "ace" ? " (ace's copy)" : ""}`
      : "serve-sim not downloaded",
    hint: `Download device tools in Devices: ace keeps its own serve-sim ${pinnedServeSim}.`,
    ...(status.version ? { version: status.version } : {}),
  };
}

/** serve-sim as the devices service would run it: ace's downloaded copy under `dataDir` first. */
export function daemonServeSim(dataDir: string | undefined) {
  return async (env: NodeJS.ProcessEnv): Promise<ServeSimStatus> =>
    serveSimStatus(
      env,
      {
        spawn: spawnRawSupervised,
        after(ms, run) {
          const timer = setTimeout(run, ms);
          return () => clearTimeout(timer);
        },
      },
      dataDir
        ? await managedServeSim({ directory: join(dataDir, "tools"), node: process.execPath })
        : undefined,
    );
}

/** The machine's toolchains; on a Mac, serve-sim follows Xcode. */
export async function daemonToolchains(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  serveSim: (env: NodeJS.ProcessEnv) => Promise<ServeSimStatus> = daemonServeSim(undefined),
): Promise<Toolchain[]> {
  if (platform !== "darwin") return detectToolchains(env, platform);
  const [tools, status] = await Promise.all([detectToolchains(env, platform), serveSim(env)]);
  const xcode = tools.findIndex((tool) => tool.id === "xcode");
  tools.splice(xcode + 1, 0, serveSimToolchain(status));
  return tools;
}
