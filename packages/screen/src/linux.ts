import { join } from "node:path";
import { z } from "zod";
import { noGraphicalSessionMessage } from "./linux-session.ts";
export type LinuxBackend = "x11" | "wayland";
const Backend = z.enum(["x11", "wayland"]);
/** Wayland wins over DISPLAY because an XWayland connection cannot authorize native input. */
export function linuxBackend(env: NodeJS.ProcessEnv, selection?: LinuxBackend): LinuxBackend {
  const selected =
    selection ?? (env.ACE_SCREEN_BACKEND ? Backend.parse(env.ACE_SCREEN_BACKEND) : undefined);
  if (selected === "wayland" && env.WAYLAND_DISPLAY) return selected;
  if (selected === "x11" && env.DISPLAY) return selected;
  if (!selected && env.WAYLAND_DISPLAY) return "wayland";
  if (!selected && env.DISPLAY) return "x11";
  throw new Error(
    selected
      ? `No display session for the ${selected} backend: set ${selected === "wayland" ? "WAYLAND_DISPLAY" : "DISPLAY"} or unset ACE_SCREEN_BACKEND`
      : noGraphicalSessionMessage,
  );
}
/** How a live-view helper starts in this graphical session; throws when there is none. */
export function linuxLaunch(env: NodeJS.ProcessEnv, artifactDirectory: string) {
  const backend = linuxBackend(env);
  return {
    expectedPlatform: backend === "x11" ? ("linux-x11" as const) : ("linux-wayland" as const),
    args: [
      "--backend",
      backend,
      "--restore-token",
      join(artifactDirectory, "portal", "restore-token"),
    ],
    env,
  };
}
export function installedLinuxHelper(dataDirectory: string, arch: string): string {
  if (arch !== "x64" && arch !== "arm64")
    throw new Error("Linux screen helper supports x86_64 and aarch64");
  return join(dataDirectory, "helpers", "screen-linux", arch, "ace-screen-helper-linux");
}
