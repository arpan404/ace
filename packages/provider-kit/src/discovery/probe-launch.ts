import { open } from "node:fs/promises";
import { basename, delimiter, dirname, join } from "node:path";
import { findInstalledExecutable } from "./shim-resolver.ts";
import { VersionManagerToolMissingError, versionManagerShim } from "./version-manager-shim.ts";

/**
 * Settings that stop each version manager installing or downloading when one of its shims
 * runs anyway, from a grandchild ace doesn't see. mise: checked against 2026.11. proto: its
 * documented auto-install and offline switches. volta: `VOLTA_BYPASS` runs the system tool
 * instead of fetching one. asdf never installs on use, so it needs none.
 */
export const NO_INSTALL_ENV: Readonly<Record<string, string>> = {
  MISE_OFFLINE: "1",
  MISE_AUTO_INSTALL: "0",
  MISE_EXEC_AUTO_INSTALL: "0",
  MISE_NOT_FOUND_AUTO_INSTALL: "0",
  MISE_TASK_RUN_AUTO_INSTALL: "0",
  PROTO_AUTO_INSTALL: "false",
  PROTO_OFFLINE: "1",
  VOLTA_BYPASS: "1",
};

/** How a probe of `executable` runs. */
export type ProbeLaunch = { command: string; args: readonly string[]; env: NodeJS.ProcessEnv };

/**
 * A probe's launch with no route to a version manager's shim. A CLI is often a script whose
 * interpreter (`#!/usr/bin/env node`) comes from PATH, and on PATH may be a shim that installs
 * when it runs. So the interpreter is resolved like the CLI itself: its installed directory goes
 * first on PATH, shim directories leave it, and a shim named outright in the `#!` line is
 * replaced by the binary it stands for. An interpreter whose tool isn't installed, or that can't
 * be resolved, means the probe doesn't run. Every probe also gets `NO_INSTALL_ENV`.
 */
export async function probeLaunch(
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  options: { signal?: AbortSignal; cwd?: string } = {},
): Promise<ProbeLaunch> {
  const pathKey = pathVariable(env);
  const entries = (env[pathKey] ?? "").split(delimiter).filter(Boolean);
  const runtimeDirectories: string[] = [];
  let launch: { command: string; args: readonly string[] } = { command: executable, args };
  const shebang = await interpreterLine(executable);
  if (shebang) {
    const viaEnv = basename(shebang.interpreter) === "env";
    const interpreter = viaEnv ? shebang.args[0] : shebang.interpreter;
    const interpreterArgs = viaEnv ? shebang.args.slice(1) : shebang.args;
    const found = interpreter
      ? await findInstalledExecutable(interpreter, env, options)
      : undefined;
    if (found && "refused" in found) throw found.refused;
    if (found && "absent" in found) throw new VersionManagerToolMissingError(found.path);
    if (found && found.run !== found.path) {
      runtimeDirectories.push(dirname(found.run));
      // A shim named outright can't be avoided through PATH: run what it stands for instead.
      if (!viaEnv) launch = { command: found.run, args: [...interpreterArgs, executable, ...args] };
    }
  }
  const path = [...runtimeDirectories, ...entries.filter((entry) => !isShimDirectory(entry))].join(
    delimiter,
  );
  return { ...launch, env: { ...env, [pathKey]: path, ...NO_INSTALL_ENV } };
}

/** A PATH entry that holds only a version manager's shims. */
function isShimDirectory(entry: string): boolean {
  return versionManagerShim(join(entry, "tool"), "") !== undefined;
}

/** Windows spells PATH any way it likes; keep the spelling the environment already has. */
function pathVariable(env: NodeJS.ProcessEnv): string {
  if (process.platform !== "win32") return "PATH";
  return Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "Path";
}

/** The `#!` line of a script: its interpreter and the arguments that line passes it. */
async function interpreterLine(
  executable: string,
): Promise<{ interpreter: string; args: string[] } | undefined> {
  let head: Buffer;
  try {
    const file = await open(executable, "r");
    try {
      const buffer = Buffer.alloc(512);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      head = buffer.subarray(0, bytesRead);
    } finally {
      await file.close();
    }
  } catch {
    return undefined;
  }
  if (head[0] !== 0x23 || head[1] !== 0x21) return undefined;
  const line = head.toString("utf8", 2).split(/\r?\n/, 1)[0] ?? "";
  const [interpreter, ...rest] = line.trim().split(/\s+/);
  if (!interpreter) return undefined;
  // `env -S node --flag` splits the rest itself; `env`'s own flags and NAME=value assignments
  // come before the interpreter's name.
  const args =
    basename(interpreter) === "env"
      ? rest.filter((arg) => !arg.startsWith("-") && !arg.includes("="))
      : rest;
  return { interpreter, args };
}
