import { detectToolchains } from "@ace/diagnostics";
import { pinnedServeSim, serveSimStatus, type ServeSimStatus } from "@ace/devices";
import { spawnRawSupervised } from "@ace/provider-kit/process";
import type { Toolchain } from "@ace/protocol";

/** How serve-sim, which streams the iOS Simulator, reads in the toolchain list. */
export function serveSimToolchain(status: ServeSimStatus): Toolchain {
  return {
    id: "serve-sim",
    available: status.supported,
    detail: status.command
      ? `serve-sim ${status.version ?? "(unknown version)"}`
      : "serve-sim not found",
    hint: `Install the pinned version: npm install -g serve-sim@${pinnedServeSim}`,
    ...(status.version ? { version: status.version } : {}),
  };
}

/** The machine's toolchains; on a Mac, serve-sim follows Xcode. */
export async function daemonToolchains(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  serveSim: (env: NodeJS.ProcessEnv) => Promise<ServeSimStatus> = (probeEnv) =>
    serveSimStatus(probeEnv, {
      spawn: spawnRawSupervised,
      after(ms, run) {
        const timer = setTimeout(run, ms);
        return () => clearTimeout(timer);
      },
    }),
): Promise<Toolchain[]> {
  if (platform !== "darwin") return detectToolchains(env, platform);
  const [tools, status] = await Promise.all([detectToolchains(env, platform), serveSim(env)]);
  const xcode = tools.findIndex((tool) => tool.id === "xcode");
  tools.splice(xcode + 1, 0, serveSimToolchain(status));
  return tools;
}
