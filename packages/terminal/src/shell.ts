import { accessSync, constants } from "node:fs";
import { win32 } from "node:path";
import { findExecutableSync } from "@ace/provider-kit/discovery";

export interface ShellSelectionEnv {
  readonly SHELL?: string | undefined;
  readonly ComSpec?: string | undefined;
  readonly COMSPEC?: string | undefined;
  readonly SystemRoot?: string | undefined;
  readonly SYSTEMROOT?: string | undefined;
  readonly [key: string]: string | undefined;
}

export interface ShellSelectionPorts {
  readonly platform?: NodeJS.Platform | undefined;
  readonly env?: ShellSelectionEnv | undefined;
  readonly exists?: ((path: string) => boolean) | undefined;
  readonly findExecutable?:
    | ((command: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform) => string | undefined)
    | undefined;
}

function defaultExists(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Default shell selection. An explicit shell always wins and is returned
 * without an existence check; a configured shell that cannot launch fails at
 * spawn rather than silently selecting another shell.
 *
 * POSIX keeps the existing behavior: `$SHELL`, then `/bin/zsh`, `/bin/bash`.
 * Windows never reads POSIX `$SHELL`: `pwsh` (via shared PATH/PATHEXT
 * lookup), then `powershell`, then `%ComSpec%`, then
 * `%SystemRoot%\System32\cmd.exe` when that file exists. Windows keys match
 * case-insensitively, empty values count as missing, and SystemRoot must be
 * drive-absolute so the fallback never depends on the cwd.
 *
 * Selection only; the ConPTY backend spawns the selected shell directly.
 */
export function resolveShell(shell?: string, ports?: ShellSelectionPorts): string {
  if (shell !== undefined) return shell;
  const platform: NodeJS.Platform = ports?.platform ?? process.platform;
  const env: ShellSelectionEnv = ports?.env ?? process.env;
  const exists: (path: string) => boolean = ports?.exists ?? defaultExists;
  const find: (
    command: string,
    env: NodeJS.ProcessEnv,
    platform: NodeJS.Platform,
  ) => string | undefined = ports?.findExecutable ?? findExecutableSync;
  if (platform === "win32") return resolveWindowsShell(env, exists, find);
  const posixShell = env.SHELL;
  if (posixShell !== undefined && posixShell !== "") return posixShell;
  for (const candidate of ["/bin/zsh", "/bin/bash"]) {
    if (exists(candidate)) return candidate;
  }
  throw new Error("No login shell found");
}

function lookupWindowsEnv(env: ShellSelectionEnv, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === wanted) {
      const value = env[key];
      if (value !== undefined && value !== "") return value;
    }
  }
  return undefined;
}

/**
 * Windows env blocks are case-insensitive: merge `overrides` over `base` so a
 * later key wins regardless of spelling, and `undefined` masks (removes) any
 * inherited spelling. Pre-existing duplicates inside `base` are preserved:
 * real Windows hosts never carry them (Node already folds `process.env`
 * there). No public provider-kit helper owns this; POSIX callers keep
 * case-sensitive behavior by not using it.
 */
export function mergeWindowsEnv(
  base: Readonly<Record<string, string | undefined>>,
  overrides: Readonly<Record<string, string | undefined>> | undefined,
): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = { ...base };
  const byLower = new Map<string, string>();
  for (const key of Object.keys(merged)) byLower.set(key.toLowerCase(), key);
  for (const [key, value] of Object.entries(overrides ?? {})) {
    const prior = byLower.get(key.toLowerCase());
    if (prior !== undefined && prior !== key) {
      delete merged[prior];
      byLower.delete(prior);
    }
    if (value === undefined) {
      delete merged[key];
      byLower.delete(key.toLowerCase());
    } else {
      merged[key] = value;
      byLower.set(key.toLowerCase(), key);
    }
  }
  return merged;
}

function isDriveAbsoluteSystemRoot(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value);
}

function resolveWindowsShell(
  env: ShellSelectionEnv,
  exists: (path: string) => boolean,
  find: (command: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform) => string | undefined,
): string {
  const lookupEnv: NodeJS.ProcessEnv = { ...env };
  for (const candidate of ["pwsh", "powershell"]) {
    const found = find(candidate, lookupEnv, "win32");
    if (found !== undefined && found !== "") return found;
  }
  const comSpec = lookupWindowsEnv(env, "comspec");
  if (comSpec !== undefined) return comSpec;
  const systemRoot = lookupWindowsEnv(env, "systemroot");
  if (systemRoot !== undefined && isDriveAbsoluteSystemRoot(systemRoot)) {
    const candidate = win32.join(systemRoot, "System32", "cmd.exe");
    if (exists(candidate)) return candidate;
  }
  throw new Error("No login shell found");
}
