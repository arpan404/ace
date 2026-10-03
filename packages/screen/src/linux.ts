import { join } from "node:path";
import { z } from "zod";
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
    "No display session: set DISPLAY or WAYLAND_DISPLAY; headless computer use is unavailable",
  );
}
export function installedLinuxHelper(dataDirectory: string, arch: string): string {
  if (arch !== "x64" && arch !== "arm64")
    throw new Error("Linux screen helper supports x86_64 and aarch64");
  return join(dataDirectory, "helpers", "screen-linux", arch, "ace-screen-helper-linux");
}
