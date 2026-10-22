import { accessSync, constants } from "node:fs";
import { win32 } from "node:path";

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
 * Windows never reads POSIX `$SHELL`: `%ComSpec%`, then
 * `%SystemRoot%\System32\cmd.exe` when that file exists. Windows keys match
 * case-insensitively, empty values count as missing, and SystemRoot must be
 * drive-absolute so the fallback never depends on the cwd.
 *
 * Selection only; Windows process spawning stays unimplemented and the POSIX
 * backend still refuses `win32` until a ConPTY backend exists.
 */
export function resolveShell(shell?: string, ports?: ShellSelectionPorts): string {
  if (shell !== undefined) return shell;
  const platform: NodeJS.Platform = ports?.platform ?? process.platform;
  const env: ShellSelectionEnv = ports?.env ?? process.env;
  const exists: (path: string) => boolean = ports?.exists ?? defaultExists;
  if (platform === "win32") return resolveWindowsShell(env, exists);
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

function isDriveAbsoluteSystemRoot(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value);
}

function resolveWindowsShell(env: ShellSelectionEnv, exists: (path: string) => boolean): string {
  const comSpec = lookupWindowsEnv(env, "comspec");
  if (comSpec !== undefined) return comSpec;
  const systemRoot = lookupWindowsEnv(env, "systemroot");
  if (systemRoot !== undefined && isDriveAbsoluteSystemRoot(systemRoot)) {
    const candidate = win32.join(systemRoot, "System32", "cmd.exe");
    if (exists(candidate)) return candidate;
  }
  throw new Error("No login shell found");
}
