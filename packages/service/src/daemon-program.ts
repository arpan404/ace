import { randomUUID } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  linkSync,
  lstatSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { desktopAppMarker } from "./desktop-update.ts";
import { daemonRuntimePath } from "./process-names.ts";

/** One way to start the daemon: a program and its arguments. */
export interface DaemonLaunch {
  command: string;
  args: string[];
}

/**
 * The launches that start the daemon from `entry` with `words` (`start`, `serve --json`), most
 * preferred first: the runtime under the daemon's name `named`, then the runtime itself.
 *
 * The named runtime is always ace's own Bun, which behaves differently when its executable is
 * not named `node` (ADR 0214): it loads `.env`, `.env.local` and `.env.<NODE_ENV>` from the
 * working directory, which `ace open` inherits from wherever it was run, and reads a first bare
 * word as a command of its own (`install`, `run`, `test`). So that launch passes
 * `--no-env-file` and an absolute script first. The plain runtime keeps the arguments it always
 * had: Node rejects `--no-env-file`, and Bun named `node` reads no `.env`.
 */
export function daemonLaunches(
  runtime: string,
  named: string,
  entry: string,
  words: readonly string[],
): DaemonLaunch[] {
  const plain = { command: runtime, args: [entry, ...words] };
  if (named === runtime) return [plain];
  if (!isAbsolute(entry)) throw new Error(`The daemon's entry script must be absolute: ${entry}`);
  return [{ command: named, args: ["--no-env-file", entry, ...words] }, plain];
}

/**
 * The program that starts the daemon on the runtime at `runtime`, so it shows as `ace Service`
 * (`ace-service` on Linux) rather than as the runtime:
 *
 * - in the desktop app, the runtime's copy under that name, when it ships a runnable one;
 * - in a release ace installed (`<ACE_HOME>/releases/<release>/`), a hard link to the runtime
 *   beside it, accepted only while it is the very same file, else made afresh. The archive holds
 *   only files (the updaters of earlier releases accept no link entries), so the link is made
 *   on first start; it shares the runtime's bytes and signature and costs no space.
 *
 * Anywhere else (a Homebrew keg, an npm package), or when the name holds something else that
 * ace may not replace, the daemon runs on the runtime as it is.
 */
export function startableDaemonRuntime(runtime: string, platform: NodeJS.Platform): string {
  const named = daemonRuntimePath(runtime, platform);
  if (inDesktopApp(runtime, platform)) return runnableFile(named, platform) ? named : runtime;
  if (!inInstalledRelease(runtime)) return runtime;
  return linked(runtime, named) ? named : runtime;
}

/**
 * Starts the daemon with the first of `launches` that can be spawned: the named runtime, then
 * the plain one. A spawn that fails (the file went missing or cannot run) has no pid at once.
 */
export function spawnDaemonRuntime<
  Child extends { pid?: number | undefined; once(event: "error", listener: () => void): unknown },
>(launches: readonly DaemonLaunch[], start: (launch: DaemonLaunch) => Child): Child {
  const last = launches.length - 1;
  for (const [index, launch] of launches.entries()) {
    const child = start(launch);
    if (child.pid !== undefined || index === last) return child;
    // Its spawn error arrives later; this attempt is already given up.
    child.once("error", () => {});
  }
  throw new Error("No runtime to start the daemon on");
}

/** `resources/runtime/bin/node` (`resources\runtime\node.exe`) beside the app's daemon marker. */
function inDesktopApp(runtime: string, platform: NodeJS.Platform): boolean {
  const folder = platform === "win32" ? dirname(runtime) : dirname(dirname(runtime));
  return existsSync(join(dirname(folder), "daemon", desktopAppMarker));
}

/** `<ACE_HOME>/releases/<release>/bin/node` beside its `release.json`. */
function inInstalledRelease(runtime: string): boolean {
  const release = dirname(dirname(runtime));
  return basename(dirname(release)) === "releases" && existsSync(join(release, "release.json"));
}

function runnableFile(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (platform !== "win32") accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Whether `a` and `b` name one file: the same device and inode (file index on Windows). */
function sameFile(a: string, b: string): boolean {
  try {
    const [left, right] = [statSync(a, { bigint: true }), statSync(b, { bigint: true })];
    return left.ino !== 0n && left.dev === right.dev && left.ino === right.ino;
  } catch {
    return false;
  }
}

/**
 * Makes `named` a hard link to `runtime`: kept when it already is one, else linked beside it and
 * moved into place, so no start ever sees it half made. A folder or anything else that is not a
 * plain file or link is left alone.
 */
function linked(runtime: string, named: string): boolean {
  if (sameFile(runtime, named)) return true;
  try {
    const entry = lstatSync(named);
    if (!entry.isFile() && !entry.isSymbolicLink()) return false;
  } catch {
    // Missing: made below.
  }
  const temporary = `${named}.${randomUUID()}.link`;
  try {
    linkSync(runtime, temporary);
    renameSync(temporary, named);
  } catch {
    // No hard links on this file system, or Windows holds a running image under that name.
    rmSync(temporary, { force: true });
  }
  // A concurrent start may have linked it first; either way only the same file counts.
  return sameFile(runtime, named);
}
