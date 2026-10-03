import { join } from "node:path";

export interface AppPaths {
  preload: string;
  renderer: string;
  daemonEntry: string;
  screenHelper: string | undefined;
  /** The macOS helper's pinned hashes; outside `Contents/Helpers`, which may hold only code. */
  screenHelperManifest: string | undefined;
  binDirectory: string;
  /** The bundled Node runtime the daemon runs on (absent on Windows, which has no daemon). */
  node: string;
}

const helperNames: Partial<Record<NodeJS.Platform, string>> = {
  win32: "ace-screen-helper-windows.exe",
  linux: "ace-screen-helper-linux",
};

/**
 * Where the built pieces live. `dist/app` holds main, preload and the renderer (the asar in
 * a package); the daemon bundle, helpers and `rg` sit beside it in `dist/` and are copied to
 * `Contents/Resources` (and the macOS helper to `Contents/Helpers`) when packaged.
 */
export function appPaths(options: {
  appDirectory: string;
  packaged: boolean;
  resourcesPath: string;
  platform: NodeJS.Platform;
}): AppPaths {
  const resources = options.packaged ? options.resourcesPath : join(options.appDirectory, "..");
  const helper = helperNames[options.platform];
  const screenHelper =
    options.platform === "darwin"
      ? options.packaged
        ? join(options.resourcesPath, "..", "Helpers", "AceScreenHelper.app")
        : join(resources, "helpers", "AceScreenHelper.app")
      : helper
        ? join(resources, "helpers", helper)
        : undefined;
  return {
    preload: join(options.appDirectory, "preload.cjs"),
    renderer: join(options.appDirectory, "renderer"),
    daemonEntry: join(resources, "daemon", "ace.mjs"),
    screenHelper,
    screenHelperManifest:
      options.platform !== "darwin"
        ? undefined
        : options.packaged
          ? join(options.resourcesPath, "screen-helper-manifest.json")
          : join(resources, "helpers", "manifest.json"),
    binDirectory: join(resources, "bin"),
    node: join(resources, "runtime", "bin", "node"),
  };
}
