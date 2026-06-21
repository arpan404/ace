import * as OS from "node:os";
import * as Path from "node:path";
export function resolveDesktopBaseDir(options?: {
  homeDir?: string;
  isDevelopment?: boolean;
  appType?: "web" | "desktop";
}): string {
  const homeDir = options?.homeDir ?? OS.homedir();
  const appType = options?.appType;
  if (options?.isDevelopment && appType) {
    return Path.join(homeDir, ".ace", "dev", appType);
  }
  return Path.join(homeDir, ".ace", ...(options?.isDevelopment === true ? ["dev"] : []));
}

export function resolveDesktopUserDataPath(options: {
  platform: NodeJS.Platform;
  userDataDirName: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}): string {
  const homeDir = options.homeDir ?? OS.homedir();
  const env = options.env ?? process.env;
  const appDataBase =
    options.platform === "win32"
      ? env.APPDATA || Path.join(homeDir, "AppData", "Roaming")
      : options.platform === "darwin"
        ? Path.join(homeDir, "Library", "Application Support")
        : env.XDG_CONFIG_HOME || Path.join(homeDir, ".config");

  return Path.join(appDataBase, options.userDataDirName);
}
