import { posix, win32 } from "node:path";

/**
 * Where the person's own gh and git look for their configuration, computed from the
 * person's environment before ace gives a provider a private HOME or XDG root. Pure: each
 * function follows that tool's documented lookup order for the given platform.
 */
export interface UserToolPathsInput {
  platform: NodeJS.Platform;
  /** The person's environment, never one ace has already redirected. */
  env: NodeJS.ProcessEnv;
}

const pathFor = (platform: NodeJS.Platform) => (platform === "win32" ? win32 : posix);

/**
 * gh: GH_CONFIG_DIR, then `$XDG_CONFIG_HOME/gh`, then `%AppData%\GitHub CLI` on Windows,
 * then `~/.config/gh` (Go's user home: USERPROFILE on Windows, HOME elsewhere).
 */
export function ghConfigDir(input: UserToolPathsInput): string | undefined {
  const { env, platform } = input;
  const path = pathFor(platform);
  if (env.GH_CONFIG_DIR) return env.GH_CONFIG_DIR;
  if (env.XDG_CONFIG_HOME) return path.join(env.XDG_CONFIG_HOME, "gh");
  if (platform === "win32" && env.APPDATA) return path.join(env.APPDATA, "GitHub CLI");
  const home = platform === "win32" ? env.USERPROFILE : env.HOME;
  return home ? path.join(home, ".config", "gh") : undefined;
}

/**
 * Git's home, in the order git tries it: HOME on every platform; on Windows without HOME,
 * HOMEDRIVE+HOMEPATH when that folder exists, then USERPROFILE. The caller checks which
 * Windows candidate exists; the last one is the fallback.
 */
export function gitHomeCandidates(input: UserToolPathsInput): string[] {
  const { env, platform } = input;
  if (env.HOME) return [env.HOME];
  if (platform !== "win32") return [];
  return [
    ...(env.HOMEDRIVE && env.HOMEPATH ? [win32.join(env.HOMEDRIVE, env.HOMEPATH)] : []),
    ...(env.USERPROFILE ? [env.USERPROFILE] : []),
  ];
}

/**
 * Git's two global files, in the order git reads them: the XDG file
 * (`$XDG_CONFIG_HOME/git/config`, or `<home>/.config/git/config`) and then `<home>/.gitconfig`.
 */
export function gitGlobalFiles(input: UserToolPathsInput & { home: string }): string[] {
  const path = pathFor(input.platform);
  const xdg = input.env.XDG_CONFIG_HOME || path.join(input.home, ".config");
  return [path.join(xdg, "git", "config"), path.join(input.home, ".gitconfig")];
}
