import { join } from "node:path";

export interface AppPaths {
  preload: string;
  renderer: string;
  daemonEntry: string;
  screenHelper: string | undefined;
  binDirectory: string;
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
    binDirectory: join(resources, "bin"),
  };
}
