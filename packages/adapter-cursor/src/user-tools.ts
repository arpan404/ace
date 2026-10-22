import { access, lstat, mkdir, readlink, rm, symlink } from "node:fs/promises";
import { posix, win32 } from "node:path";

export interface UserToolsInput {
  platform: NodeJS.Platform;
  /** The person's real home, before Cursor's private HOME replaces it. */
  userHome: string;
  /** The launch environment; explicit GH_CONFIG_DIR or GIT_CONFIG_GLOBAL there win. */
  env: NodeJS.ProcessEnv;
  exists?: (path: string) => Promise<boolean>;
}

const fileExists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/**
 * Cursor's SDK finds its login through `os.homedir()`, so its host runs with HOME (and
 * USERPROFILE on Windows) set to ace's private instance home. This points the person's own
 * gh and git back at their real configuration, so tools inside a Cursor session behave as
 * they do in a terminal. Each path follows the tool's own lookup order on every platform.
 */
export async function userToolEnv(input: UserToolsInput): Promise<NodeJS.ProcessEnv> {
  const { platform, userHome, env } = input;
  const join = platform === "win32" ? win32.join : posix.join;
  const out: NodeJS.ProcessEnv = {};
  if (!env.GH_CONFIG_DIR)
    out.GH_CONFIG_DIR = env.XDG_CONFIG_HOME
      ? join(env.XDG_CONFIG_HOME, "gh")
      : platform === "win32" && env.APPDATA
        ? join(env.APPDATA, "GitHub CLI")
        : join(userHome, ".config", "gh");
  if (!env.GIT_CONFIG_GLOBAL) {
    // Git reads both of these; GIT_CONFIG_GLOBAL takes one, so prefer the file that
    // exists, and otherwise the one `git config --global` would create in a terminal.
    const home = join(userHome, ".gitconfig");
    const xdg = join(env.XDG_CONFIG_HOME || join(userHome, ".config"), "git", "config");
    const exists = input.exists ?? fileExists;
    out.GIT_CONFIG_GLOBAL = (await exists(home)) || !(await exists(xdg)) ? home : xdg;
  }
  return out;
}

/**
 * On macOS the keychain search list is found through HOME, so with Cursor's private HOME
 * `gh` sees the person's account but cannot read its token. Link the private home's
 * `Library/Keychains` to the person's own. Cursor's SDK keeps its login in a file under
 * `.cursor/sdk`, never the keychain, so accounts stay apart. Windows Credential Manager and
 * the Linux secret service do not depend on HOME, so nothing is needed there. A real folder
 * already at that path is left alone.
 */
export async function linkUserKeychains(input: {
  platform: NodeJS.Platform;
  userHome: string;
  privateHome: string;
}): Promise<void> {
  if (input.platform !== "darwin") return;
  const source = posix.join(input.userHome, "Library", "Keychains");
  const link = posix.join(input.privateHome, "Library", "Keychains");
  const existing = await lstat(link).catch(() => undefined);
  if (existing && !existing.isSymbolicLink()) return;
  if (existing) {
    if ((await readlink(link)) === source) return;
    await rm(link);
  }
  await mkdir(posix.dirname(link), { recursive: true, mode: 0o700 });
  await symlink(source, link);
}
