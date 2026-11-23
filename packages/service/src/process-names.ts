import { basename, dirname, join } from "node:path";

/**
 * The names ace's background processes ship under, so Activity Monitor, Task Manager and `ps`
 * show them as ace services, in the style Electron gives the app's own ("ace Helper"). The one
 * definition packaging, the daemon and the desktop app share. Cargo packages keep their own
 * names (`ace-media`, ...): staging copies the built binary to the shipped one.
 *
 * - macOS: `ace Media Service`; Windows: `ace Media Service.exe`;
 * - Linux: `ace-media-service` (no spaces in file names there).
 */
export type AceProcess = "daemon" | "media" | "files" | "history";

const titles: Record<AceProcess, string> = {
  daemon: "ace Service",
  media: "ace Media Service",
  files: "ace Files Service",
  history: "ace History Service",
};

/** The executable file name `process` ships under on `platform`. */
export function shippedExecutableName(process: AceProcess, platform: NodeJS.Platform): string {
  const title = titles[process];
  if (platform === "win32") return `${title}.exe`;
  if (platform === "darwin") return title;
  return title.toLowerCase().replaceAll(" ", "-");
}

/**
 * The bundled runtime's own name (`bin/node`, `node.exe`). Every script that is not the daemon
 * (the CLI, terminal guardians, serve-sim, MCP servers) runs on the runtime under this name.
 */
export function scriptRuntimeName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "node.exe" : "node";
}

/** The runtime under the daemon's name, beside the script runtime at `runtime`. */
export function daemonRuntimePath(runtime: string, platform: NodeJS.Platform): string {
  return join(dirname(runtime), shippedExecutableName("daemon", platform));
}

/**
 * The runtime the daemon's own child scripts should run on. Started as `ace Service`, the
 * daemon hands its children the runtime's plain name beside it, so only the daemon itself
 * shows as the service; any other runtime is returned as it is.
 */
export function scriptRuntimePath(
  execPath: string,
  platform: NodeJS.Platform,
  exists: (path: string) => boolean,
): string {
  if (basename(execPath) !== shippedExecutableName("daemon", platform)) return execPath;
  const plain = join(dirname(execPath), scriptRuntimeName(platform));
  return exists(plain) ? plain : execPath;
}

/**
 * The program that starts the daemon from a bundle whose runtime is `runtime`: its copy under
 * the daemon's name when the bundle carries one (the desktop app's), else the runtime itself,
 * as a bundle from before the rename has only that.
 */
export function bundledDaemonRuntime(
  runtime: string,
  platform: NodeJS.Platform,
  exists: (path: string) => boolean,
): string {
  const named = daemonRuntimePath(runtime, platform);
  return exists(named) ? named : runtime;
}
