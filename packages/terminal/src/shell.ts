import { accessSync, constants } from "node:fs";
import { userInfo } from "node:os";
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
  /**
   * The account's login shell (`os.userInfo().shell`); null where the OS doesn't say. Defaults
   * to the real account only when `env` is the real environment too.
   */
  readonly accountShell?: (() => string | null) | undefined;
  readonly findExecutable?:
    | ((command: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform) => string | undefined)
    | undefined;
}

function systemAccountShell(): string | null {
  try {
    return userInfo().shell;
  } catch {
    return null;
  }
}

// Accounts that may not log in name these instead of a shell.
const refusing = /\/(?:nologin|false)$/;

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
 * POSIX: `$SHELL` (the session's choice), then the account's login shell (a daemon started
 * by systemd or launchd may have no `$SHELL`) unless it refuses logins, then the first of
 * `/bin/zsh`, `/bin/bash` and `/bin/sh` that is installed.
 * Windows never reads POSIX `$SHELL`: `pwsh` (via shared PATH/PATHEXT
 * lookup), then `powershell`, then `%ComSpec%`, then
 * `%SystemRoot%\System32\cmd.exe` when that file exists. Windows keys match
 * case-insensitively, empty values count as missing, and SystemRoot must be
 * drive-absolute so the fallback never depends on the cwd.
 *
 * Selection only; each backend spawns the selected shell directly.
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
  const accountShell = ports?.accountShell ?? (ports?.env ? () => null : systemAccountShell);
  const account = accountShell();
  if (account && !refusing.test(account) && exists(account)) return account;
  for (const candidate of ["/bin/zsh", "/bin/bash", "/bin/sh"]) {
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
 * Windows env blocks are case-insensitive: a later key wins regardless of spelling, and
 * `undefined` masks (removes) any inherited spelling. Duplicates already inside `base` are
 * kept: real Windows hosts never carry them (Node folds `process.env` there).
 */
function mergeIgnoringCase(
  base: Readonly<Record<string, string | undefined>>,
  overrides: Readonly<Record<string, string | undefined>> | undefined,
): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = { ...base };
  const byLower = new Map<string, string>();
  for (const key of Object.keys(merged)) byLower.set(key.toLowerCase(), key);
  for (const [key, value] of Object.entries(overrides ?? {})) {
    const prior = byLower.get(key.toLowerCase());
    if (prior !== undefined) delete merged[prior];
    byLower.delete(key.toLowerCase());
    if (value === undefined) continue;
    merged[key] = value;
    byLower.set(key.toLowerCase(), key);
  }
  return merged;
}

/**
 * The shell's environment: the daemon's, then the terminal's overrides (`undefined` removes a
 * key), with terminal colors enforced. Windows matches keys case-insensitively. Unset values are
 * dropped because node-pty would stringify them as "undefined".
 */
export function terminalEnvironment(
  base: Readonly<Record<string, string | undefined>>,
  overrides: Readonly<Record<string, string | undefined>> | undefined,
  platform: NodeJS.Platform,
): Record<string, string> {
  const merge =
    platform === "win32"
      ? mergeIgnoringCase
      : (into: typeof base, from: typeof overrides) => ({ ...into, ...from });
  const environment = merge(merge(base, overrides), {
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
  });
  // A daemon started outside a terminal (launchd, a desktop app) inherits no locale, and a POSIX
  // shell in the C locale mangles typed UTF-8. Terminal apps set one; so does ace, when unset.
  if (platform !== "win32" && !environment.LC_ALL && !environment.LC_CTYPE && !environment.LANG)
    environment.LC_CTYPE = "C.UTF-8";
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) if (value !== undefined) env[key] = value;
  return env;
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
