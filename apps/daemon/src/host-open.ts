import { spawn } from "node:child_process";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { InstalledEditor } from "@ace/protocol";
import {
  HostOpenError,
  expandHostPath,
  hostScope,
  insideTarget,
  resolveExisting,
  type HostPlaces,
  type HostScope,
  type HostTarget,
} from "./host-open-target.ts";

/*
 * `host.open`: a client on another device (a phone) opens a folder or file on the machine running
 * ace, in an installed editor or the file manager. The editor's launcher always comes from this
 * machine's own discovery, never from the client. A project-relative target never leaves its
 * folder; a host path inside no project or personal skill folder is the owner's alone. The
 * target is only ever opened or revealed, never run.
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
  /** Windows' system folder (`%SystemRoot%`); its own `explorer.exe` is the file manager. */
  systemRoot?: string | undefined;
}): HostLaunch | undefined {
  const { platform, target, isFile, line } = input;
  if (input.app.kind === "files") {
    // `open` runs a bundle folder (an `.app`) it is given, so one is revealed in its folder.
    if (platform === "darwin")
      return { command: "open", args: isFile || bundleLike(target) ? ["-R", target] : [target] };
    if (platform === "win32") {
      // Always the system's own Explorer, never one found on PATH or elsewhere.
      const explorer = join(input.systemRoot ?? "C:\\Windows", "explorer.exe");
      return { command: explorer, args: isFile ? [`/select,${target}`] : [target] };
    }
    return { command: "xdg-open", args: [isFile ? dirname(target) : target] };
  }
  const editor = input.editor;
  if (!editor || editor.id !== input.app.editorId) return undefined;
  // Windows starts only an editor's own executable: never a .cmd or .bat launcher, which only
  // a shell runs. Discovery yields only .exe files; this refuses anything else regardless.
  if (platform === "win32" && !(isAbsolute(editor.command) && /\.exe$/i.test(editor.command)))
    return undefined;
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

/** A folder macOS may treat as a bundle it runs: any whose name has an extension. */
function bundleLike(target: string): boolean {
  return /\.[A-Za-z0-9-]+$/.test(basename(target));
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

/** Where to open: a path inside a project's or thread's folder, or a path on the machine. */
export type HostPlace =
  | { kind: "inside"; root: string; path?: string | undefined }
  | {
      kind: "host";
      path: string;
      home: string;
      /** The folders an `operate` device may open in, found when asked. */
      places: () => HostPlaces | Promise<HostPlaces>;
    };

/** The target `place` names, and who may open it. */
async function resolvePlace(
  place: HostPlace,
  platform: NodeJS.Platform,
): Promise<HostTarget & { scope: HostScope; again: () => Promise<HostTarget> }> {
  if (place.kind === "inside") {
    const again = () => insideTarget(place.root, place.path);
    return { ...(await again()), scope: "operate", again };
  }
  const path = expandHostPath(place.path, place.home, platform);
  if (!path) throw new HostOpenError("path_not_found");
  const again = () => resolveExisting(path);
  const found = await again();
  return { ...found, scope: await hostScope(found.target, await place.places()), again };
}

/**
 * Open `place` with `app`: resolve the target and who may open it, find the editor, then start
 * it only if the caller may still act. Resolution and discovery wait on the filesystem, so a
 * device can be revoked, lose its scope or the thread, or go away meanwhile, and a symlink on
 * the way can change; the target and `allowed` are checked again immediately before anything
 * starts.
 */
export async function openOnHost(input: {
  place: HostPlace;
  line?: number | undefined;
  app: HostApp;
  platform: NodeJS.Platform;
  /** This machine's editors, found on demand. */
  editors: () => Promise<readonly InstalledEditor[]>;
  spawn: HostSpawner;
  /** Whether the caller may still act with `scope`: connected, that scope, the thread. */
  allowed: (scope: HostScope) => boolean;
  signal: AbortSignal;
  /** Windows' system folder (`%SystemRoot%`), where its own `explorer.exe` is. */
  systemRoot?: string | undefined;
}): Promise<void> {
  const found = await resolvePlace(input.place, input.platform);
  const refuse = () => new HostOpenError(found.scope === "admin" ? "owner_only" : "forbidden");
  if (!input.allowed(found.scope)) throw refuse();
  const app = input.app;
  const editor =
    app.kind === "editor"
      ? (await input.editors()).find((entry) => entry.id === app.editorId)
      : undefined;
  const launch = hostLaunch({
    platform: input.platform,
    app,
    target: found.target,
    isFile: found.isFile,
    line: input.line,
    editor,
    systemRoot: input.systemRoot,
  });
  if (!launch) throw new Error("editor_not_found");
  const now = await found.again();
  if (now.target !== found.target || now.isFile !== found.isFile)
    throw new HostOpenError("path_not_found");
  input.signal.throwIfAborted();
  if (!input.allowed(found.scope)) throw refuse();
  await input.spawn(launch);
}
