import { join } from "node:path";
import { hasGraphicalSession, noSessionMessage } from "./linux-session.ts";
/** How a live-view helper starts in this Wayland session; throws when there is none. */
export function linuxLaunch(env: NodeJS.ProcessEnv, artifactDirectory: string) {
  if (!hasGraphicalSession(env)) throw new Error(noSessionMessage(env));
  return {
    expectedPlatform: "linux-wayland" as const,
    args: ["--restore-token", join(artifactDirectory, "portal", "restore-token")],
    env,
  };
}
export function installedLinuxHelper(dataDirectory: string, arch: string): string {
  if (arch !== "x64" && arch !== "arm64")
    throw new Error("Linux screen helper supports x86_64 and aarch64");
  return join(dataDirectory, "helpers", "screen-linux", arch, "ace-screen-helper-linux");
}
