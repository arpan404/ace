import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { probeOffThread } from "../probe-thread.ts";
import { findExecutable } from "./executable.ts";
import {
  VersionManagerShimError,
  versionManagerShim,
  type VersionManager,
} from "./version-manager-shim.ts";

/**
 * A command found on PATH, as ace may run it. `run` is what to execute: `path` itself, or the
 * installed binary a version manager's shim at `path` stands for. `absent` is a shim whose
 * manager reports the tool isn't installed. `refused` is a shim ace couldn't resolve without
 * risking an install. In both, ace runs nothing.
 */
export type InstalledExecutable =
  | { path: string; run: string }
  | { path: string; absent: true }
  | { path: string; refused: VersionManagerShimError };

/** How each manager names the installed binary without installing, and what "absent" reads. */
const queries: Readonly<
  Record<
    VersionManager,
    {
      launcher: string;
      args: (tool: string) => string[];
      env: NodeJS.ProcessEnv;
      absent: RegExp;
    }
  >
> = {
  // Checked against mise 2026.11: `which` prints the install or fails with "not currently
  // active" for a lazy tool, and with these settings never downloads or installs.
  mise: {
    launcher: "mise",
    args: (tool) => ["which", tool],
    env: {
      MISE_OFFLINE: "1",
      MISE_AUTO_INSTALL: "0",
      MISE_EXEC_AUTO_INSTALL: "0",
      MISE_NOT_FOUND_AUTO_INSTALL: "0",
      MISE_TASK_RUN_AUTO_INSTALL: "0",
      MISE_QUIET: "1",
    },
    absent: /not currently active|is not installed|not installed|no version/i,
  },
  asdf: {
    launcher: "asdf",
    args: (tool) => ["which", tool],
    env: {},
    absent: /no version is set|not installed|unknown command/i,
  },
  volta: {
    launcher: "volta",
    args: (tool) => ["which", tool],
    env: {},
    absent: /could not find|not installed|no .* found/i,
  },
  proto: {
    launcher: "proto",
    args: (tool) => ["bin", tool],
    env: { PROTO_AUTO_INSTALL: "false", PROTO_OFFLINE: "1" },
    absent: /not installed|isn't installed|unable to find|no .* installed/i,
  },
};

/** A resolver gets this long; a manager that takes longer is treated as unresolvable. */
export const SHIM_RESOLVE_TIMEOUT_MS = 3_000;

/**
 * Finds `command` on `env`'s PATH and, when it is a version manager's shim, asks the manager
 * which installed binary it stands for, with installing and network access turned off.
 */
export async function findInstalledExecutable(
  command: string,
  env: NodeJS.ProcessEnv,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<InstalledExecutable | undefined> {
  // Undefined: nothing named `command` on PATH at all.
  const path = await findExecutable(command, env);
  if (!path) return undefined;
  const target = await realpath(path).catch(() => path);
  const manager = versionManagerShim(path, target);
  if (!manager) return { path, run: path };
  const query = queries[manager];
  const refuse = (reason: string) => ({
    path,
    refused: new VersionManagerShimError(path, manager, reason),
  });
  const launcher = await managerLauncher(manager, target, env);
  if (!launcher) return refuse(`${query.launcher} isn't on PATH`);
  const tool = (path.split(/[\\/]/).at(-1) ?? command).replace(/\.(?:exe|cmd|bat)$/i, "");
  let output: { stdout: string; stderr: string; code: number | null };
  try {
    output = await probeOffThread(launcher, query.args(tool), {
      env: { ...env, ...query.env },
      timeoutMs: options.timeoutMs ?? SHIM_RESOLVE_TIMEOUT_MS,
      maxBytes: 64 * 1024,
      signal: options.signal,
      schedule: (callback, ms) => {
        const timer = setTimeout(callback, ms);
        return () => clearTimeout(timer);
      },
    });
  } catch {
    options.signal?.throwIfAborted();
    return refuse(`${query.launcher} didn't answer which binary it runs`);
  }
  if (output.code !== 0)
    return query.absent.test(`${output.stderr}\n${output.stdout}`)
      ? { path, absent: true }
      : refuse(`${query.launcher} couldn't say which binary it runs`);
  const resolved = output.stdout.trim().split(/\r?\n/).at(-1)?.trim() ?? "";
  if (!isAbsolute(resolved)) return refuse(`${query.launcher} printed no binary path`);
  const run = await findExecutable(resolved, env);
  if (!run) return { path, absent: true };
  // A manager that answers with another shim would install on use all the same.
  if (versionManagerShim(run, await realpath(run).catch(() => run)))
    return refuse(`${query.launcher} resolved it to another shim`);
  return { path, run };
}

/** The manager binary: the one the shim links to, its sibling, or the first on PATH. */
async function managerLauncher(
  manager: VersionManager,
  target: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const name = queries[manager].launcher;
  const linked = target
    .split(/[\\/]/)
    .at(-1)
    ?.replace(/\.exe$/i, "")
    .toLowerCase();
  if (linked === name || (manager === "mise" && linked === "rtx")) return target;
  const sibling = await findExecutable(join(dirname(target), name), env);
  if (sibling) return sibling;
  const onPath = await findExecutable(name, env);
  if (!onPath) return undefined;
  // A manager installed through another manager's shim would resolve through that shim.
  const resolved = await realpath(onPath).catch(() => onPath);
  return versionManagerShim(onPath, resolved) === undefined ||
    versionManagerShim(onPath, resolved) === manager
    ? resolved
    : undefined;
}

/** The binary to run for `command`, or undefined when it isn't installed or can't be resolved. */
export async function launchableExecutable(
  command: string,
  env: NodeJS.ProcessEnv,
  options: { signal?: AbortSignal } = {},
): Promise<string | undefined> {
  const found = await findInstalledExecutable(command, env, options);
  return found && "run" in found ? found.run : undefined;
}
