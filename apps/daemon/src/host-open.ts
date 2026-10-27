import { spawn } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { InstalledEditor } from "@ace/protocol";

/*
 * `host.open`: a client on another device (a phone) opens a project's or thread's folder, or a
 * file in it, on the machine running ace, in an installed editor or the file manager. The
 * editor's launcher always comes from this machine's own discovery, never from the client, and
 * the target never leaves the folder it names.
 */

export type HostApp = { kind: "editor"; editorId: string } | { kind: "files" };

/** The process to start: a launcher and its arguments, never a shell line. */
export interface HostLaunch {
  command: string;
  args: string[];
}

/**
 * The launch that opens `target` (a file or folder, absolute) with `app` on `platform`. An
 * editor opens at `line` where it takes one; the file manager shows a file inside its folder.
 */
export function hostLaunch(input: {
  platform: NodeJS.Platform;
  app: HostApp;
  target: string;
  isFile: boolean;
  line?: number | undefined;
  editor?: InstalledEditor | undefined;
}): HostLaunch | undefined {
  const { platform, target, isFile, line } = input;
  if (input.app.kind === "files") {
    if (platform === "darwin") return { command: "open", args: isFile ? ["-R", target] : [target] };
    if (platform === "win32")
      return { command: "explorer.exe", args: isFile ? [`/select,${target}`] : [target] };
    return { command: "xdg-open", args: [isFile ? dirname(target) : target] };
  }
  const editor = input.editor;
  if (!editor || editor.id !== input.app.editorId) return undefined;
  const at = isFile && line ? line : undefined;
  switch (editor.id) {
    case "code":
    case "cursor":
      return { command: editor.command, args: at ? ["-g", `${target}:${at}`] : [target] };
    case "zed":
    case "subl":
      return { command: editor.command, args: [at ? `${target}:${at}` : target] };
    case "idea":
      return { command: editor.command, args: at ? ["--line", String(at), target] : [target] };
    default:
      return { command: editor.command, args: [target] };
  }
}

/**
 * `path` inside `root`, resolved through symlinks, or undefined when it would leave the folder
 * or doesn't exist. `isFile` says whether it is a file.
 */
export async function hostTarget(
  root: string,
  path: string | undefined,
): Promise<{ target: string; isFile: boolean } | undefined> {
  if (path !== undefined && (isAbsolute(path) || path.includes("\0"))) return undefined;
  try {
    const base = await realpath(root);
    const target = await realpath(resolve(base, path ?? "."));
    const inside = relative(base, target);
    if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return undefined;
    return { target, isFile: (await stat(target)).isFile() };
  } catch {
    return undefined;
  }
}

/** The platform's file manager by name. */
export function fileManagerName(platform: NodeJS.Platform): string {
  return platform === "darwin" ? "Finder" : platform === "win32" ? "File Explorer" : "Files";
}

/** Starts a detached process; resolves once it started, rejects when it couldn't. */
export type HostSpawner = (launch: HostLaunch) => Promise<void>;

/** The real spawner: detached, no shell, no inherited output, so the editor outlives nothing. */
export const spawnDetached: HostSpawner = (launch) =>
  new Promise((done, fail) => {
    const child = spawn(launch.command, launch.args, {
      detached: true,
      stdio: "ignore",
      shell: false,
      windowsHide: true,
    });
    child.once("error", fail);
    child.once("spawn", () => {
      child.unref();
      done();
    });
  });

/**
 * Open `path` inside `root` with `app`: resolve the target, find the editor, then start it only
 * if the caller may still act. Resolution and discovery wait on the filesystem, so a device can
 * be revoked, lose `operate` or the thread, or go away meanwhile; `allowed` and `signal` are
 * checked again immediately before anything starts.
 */
export async function openOnHost(input: {
  root: string;
  path?: string | undefined;
  line?: number | undefined;
  app: HostApp;
  platform: NodeJS.Platform;
  /** This machine's editors, found on demand. */
  editors: () => Promise<readonly InstalledEditor[]>;
  spawn: HostSpawner;
  /** Whether the caller may still act: connected, `operate`, and access to the thread. */
  allowed: () => boolean;
  signal: AbortSignal;
  /** Reads a Windows launcher script; the filesystem by default. */
  readLauncher?: (path: string) => Promise<string>;
}): Promise<void> {
  const found = await hostTarget(input.root, input.path);
  if (!found) throw new Error("path_not_found");
  const app = input.app;
  const editor =
    app.kind === "editor"
      ? (await input.editors()).find((entry) => entry.id === app.editorId)
      : undefined;
  const shim = hostLaunch({ platform: input.platform, app, ...found, line: input.line, editor });
  if (!shim) throw new Error("editor_not_found");
  const launch =
    input.platform === "win32" ? await windowsExecutable(shim, input.readLauncher) : shim;
  input.signal.throwIfAborted();
  if (!input.allowed()) throw new Error("forbidden");
  await input.spawn(launch);
}

/**
 * On Windows editors install `.cmd` launchers (`code.cmd`), which start only through a shell.
 * The executable the launcher runs (`"%~dp0..\Code.exe"`) starts directly instead, with the
 * same arguments and still no shell. A launcher naming no executable that exists is refused.
 */
async function windowsExecutable(
  launch: HostLaunch,
  read: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
): Promise<HostLaunch> {
  if (!/\.(?:cmd|bat)$/i.test(launch.command)) return launch;
  const script = await read(launch.command).catch(() => "");
  const named = /"([^"]*\.exe)"/i.exec(script)?.[1];
  if (!named) throw new Error("editor_not_found");
  const folder = dirname(launch.command);
  const target = named.replace(/%~dp0/gi, `${folder}${sep}`).replaceAll("\\", sep);
  const executable = isAbsolute(target) ? resolve(target) : resolve(join(folder, target));
  const found = await stat(executable).catch(() => undefined);
  if (!found?.isFile()) throw new Error("editor_not_found");
  return { command: executable, args: launch.args };
}
