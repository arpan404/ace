import { constants, existsSync } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import type { TerminalCommand } from "../../shared/contract.ts";
import {
  assertWritablePath,
  fishFile,
  fishMarker,
  hasBlock,
  localBin,
  planCliPath,
  profileBlock,
  startupFiles,
  withBlock,
  withoutBlock,
  type StartupFile,
} from "./cli-path.ts";

/** Where the `ace` shim is and whose shell's PATH it goes on. */
export interface CliPathTarget {
  platform: NodeJS.Platform;
  home: string;
  /** The shim's folder and file, as `installCliShim` reported them. */
  directory: string;
  file: string;
  env: {
    SHELL?: string | undefined;
    ZDOTDIR?: string | undefined;
    XDG_CONFIG_HOME?: string | undefined;
  };
}

/** Larger than any shell startup file ace would edit; such a file is left alone. */
const maxStartupBytes = 1024 * 1024;

/**
 * Makes `ace` reachable from a terminal: nothing when PATH already finds an `ace`, else a link
 * in `~/.local/bin` when that folder is on PATH, else ace's PATH line in the shell's startup
 * files. `path` is the login shell's PATH. Never throws.
 */
export async function putCliOnPath(target: CliPathTarget, path: string): Promise<TerminalCommand> {
  try {
    const found = await firstAce(path, target);
    const plan = planCliPath({ ...target, path, ...(found ? { found } : {}) });
    if (plan.kind === "done") return plan.status;
    if (plan.kind === "link" && (await linkShim(plan.link, target.file)))
      return { state: "ready", command: plan.link };
    return await addToProfiles(target);
  } catch (error) {
    return { state: "manual", directory: target.directory, reason: message(error) };
  }
}

/**
 * Takes back what `putCliOnPath` added: its link and its lines in every startup file it may
 * have written, whichever shell the person uses now. The person's own lines stay.
 */
export async function takeCliOffPath(target: CliPathTarget): Promise<TerminalCommand> {
  const link = localBin(target.home);
  if (await linksTo(link, target.file)) await unlink(link);
  for (const startup of everyStartupFile(target)) await removeFrom(startup);
  return { state: "off", command: target.file };
}

/** The first `ace` on PATH, and whether it is this shim (or a link to it). */
async function firstAce(
  path: string,
  target: CliPathTarget,
): Promise<{ path: string; ours: boolean } | undefined> {
  const windows = target.platform === "win32";
  const names = windows ? ["ace.cmd", "ace.exe", "ace.bat"] : ["ace"];
  const shim = await realpath(target.file).catch(() => target.file);
  for (const entry of path.split(windows ? ";" : ":")) {
    if (!entry) continue;
    for (const name of names) {
      const candidate = join(entry, name);
      if (!(await runnable(candidate, windows))) continue;
      const real = await realpath(candidate).catch(() => candidate);
      return { path: candidate, ours: real === shim };
    }
  }
  return undefined;
}

async function runnable(file: string, windows: boolean): Promise<boolean> {
  try {
    if (!(await stat(file)).isFile()) return false;
    if (!windows) await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Links `link` to the shim; false when something else is already there. */
async function linkShim(link: string, file: string): Promise<boolean> {
  if (await linksTo(link, file)) return true;
  try {
    await lstat(link);
    return false;
  } catch (error) {
    if (code(error) !== "ENOENT") throw error;
  }
  await mkdir(dirname(link), { recursive: true });
  await symlink(file, link);
  return true;
}

async function linksTo(link: string, file: string): Promise<boolean> {
  try {
    return (await lstat(link)).isSymbolicLink() && (await readlink(link)) === file;
  } catch {
    return false;
  }
}

async function addToProfiles(target: CliPathTarget): Promise<TerminalCommand> {
  const files = shellStartupFiles(target);
  if (files.length === 0)
    return {
      state: "manual",
      directory: target.directory,
      reason: `ace can't add to PATH for ${posix.basename(target.env.SHELL ?? "this shell")}`,
    };
  assertWritablePath(target.directory);
  for (const startup of files) {
    const content = await readStartup(startup.file);
    if (startup.syntax === "fish") {
      if (content !== undefined && !content.startsWith(fishMarker))
        return {
          state: "manual",
          directory: target.directory,
          reason: `${startup.file} is not ace's file`,
        };
      const next = fishFile(target.directory);
      if (content !== next) await writeStartup(startup.file, next);
    } else {
      const current = content ?? "";
      const next = withBlock(current, profileBlock(target.directory, target.home));
      if (next !== current) await writeStartup(startup.file, next);
    }
  }
  return { state: "added", files: files.map((startup) => startup.file) };
}

/** The startup files for the person's login shell. */
function shellStartupFiles(target: CliPathTarget): StartupFile[] {
  return startupFiles({
    shell: target.env.SHELL || "/bin/sh",
    home: target.home,
    platform: target.platform,
    env: target.env,
    existing: existsSync,
  });
}

/** Every file ace may have written for any shell, for turning the command off. */
function everyStartupFile(target: CliPathTarget): StartupFile[] {
  const files = new Map<string, StartupFile>();
  const add = (startup: StartupFile) => files.set(startup.file, startup);
  for (const shell of ["zsh", "fish"])
    for (const startup of startupFiles({ ...target, shell, existing: () => false })) add(startup);
  for (const name of [".zshrc", ".bashrc", ".bash_profile", ".bash_login", ".profile"])
    add({ file: join(target.home, name), syntax: "sh" });
  return [...files.values()];
}

async function removeFrom(startup: StartupFile): Promise<void> {
  const content = await readStartup(startup.file);
  if (content === undefined) return;
  if (startup.syntax === "fish") {
    if (content.startsWith(fishMarker)) await rm(startup.file, { force: true });
    return;
  }
  if (!hasBlock(content)) return;
  const next = withoutBlock(content);
  // A file that held only ace's lines was ace's; an empty `.bash_profile` would hide `.profile`.
  if (next.trim() === "") await rm(startup.file, { force: true });
  else await writeStartup(startup.file, next);
}

async function readStartup(file: string): Promise<string | undefined> {
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error(`${file} is not a file`);
    if (info.size > maxStartupBytes) throw new Error(`${file} is too large to edit`);
    return await readFile(file, "utf8");
  } catch (error) {
    if (code(error) === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Writes beside the file and renames over it, so a shell never reads half a file. A startup
 * file that is a link (a dotfiles folder) keeps its link: the file it points to is replaced.
 */
async function writeStartup(file: string, content: string): Promise<void> {
  const real = await realpath(file).catch(() => file);
  const mode = await stat(real).then(
    (info) => info.mode & 0o777,
    () => 0o644,
  );
  await mkdir(dirname(real), { recursive: true });
  const temporary = `${real}.ace-${process.pid}.tmp`;
  try {
    await writeFile(temporary, content, { mode });
    await chmod(temporary, mode);
    await rename(temporary, real);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function code(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
