import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/**
 * The folder ace's Chrome saves downloads in (`browser.downloadDir`), as stored: empty keeps
 * the default, `~` is the daemon user's home, anything else must be an absolute path to an
 * existing folder this daemon can write. Stored as its real path, so a later rename of a
 * symlink can't move downloads elsewhere. Throws a sentence for the person.
 */
export async function canonicalDownloadFolder(value: string, home: string): Promise<string> {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const expanded =
    trimmed === "~" ? home : trimmed.startsWith("~/") ? join(home, trimmed.slice(2)) : trimmed;
  if (!isAbsolute(expanded)) throw new Error("Use a full path, like ~/Downloads");
  let real: string;
  try {
    real = await realpath(expanded);
  } catch {
    throw new Error(`${trimmed} doesn't exist on this machine`);
  }
  if (!(await stat(real)).isDirectory()) throw new Error(`${trimmed} isn't a folder`);
  try {
    await access(real, constants.W_OK);
  } catch {
    throw new Error(`ace can't save files in ${trimmed}`);
  }
  return real;
}

/** What the daemon reads to find this machine's Downloads folder (injected for tests). */
export interface DownloadsHost {
  platform: NodeJS.Platform;
  home: string;
  env: Readonly<Record<string, string | undefined>>;
  readFile(path: string): Promise<string>;
}

/** The daemon's own user: HOME (a test home under vitest), the environment and its files. */
export function downloadsHost(): DownloadsHost {
  return {
    platform: process.platform,
    home: homedir(),
    env: process.env,
    readFile: (path) => readFile(path, "utf8"),
  };
}

/**
 * The operating system's Downloads folder for the daemon's user: `~/Downloads` on macOS and
 * Windows; on Linux the XDG user dirs file's `XDG_DOWNLOAD_DIR` (what `xdg-user-dir DOWNLOAD`
 * prints), else `~/Downloads`. Not checked to exist.
 */
export async function systemDownloadsFolder(host: DownloadsHost): Promise<string> {
  const fallback = join(host.home, "Downloads");
  if (host.platform !== "linux") return fallback;
  const config = host.env.XDG_CONFIG_HOME || join(host.home, ".config");
  const text = await host.readFile(join(config, "user-dirs.dirs")).catch(() => "");
  const line = /^\s*XDG_DOWNLOAD_DIR\s*=\s*"([^"]*)"/m.exec(text)?.[1];
  if (!line) return fallback;
  const path = line.replace(/^\$HOME(?=\/|$)/, host.home);
  // A Downloads dir set to $HOME itself means "no separate folder"; xdg-user-dir prints it too.
  return isAbsolute(path) ? path : fallback;
}

/** `path` when it is an existing folder this process can write, else undefined. */
export async function usableFolder(path: string): Promise<string | undefined> {
  try {
    if (!(await stat(path)).isDirectory()) return undefined;
    await access(path, constants.W_OK);
    return path;
  } catch {
    return undefined;
  }
}

/**
 * Where ace's Chrome saves a finished download: the person's `browser.downloadDir`, else this
 * machine's Downloads folder; undefined (downloads stay with each thread's browser data) when
 * that folder is missing or can't be written.
 */
export async function daemonDownloadFolder(
  chosen: string,
  host: DownloadsHost,
): Promise<string | undefined> {
  return usableFolder(chosen || (await systemDownloadsFolder(host)));
}
