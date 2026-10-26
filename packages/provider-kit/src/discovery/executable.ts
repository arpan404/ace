import { accessSync, constants, statSync } from "node:fs";
import { access, stat } from "node:fs/promises";
import { basename, isAbsolute, posix, resolve, win32 } from "node:path";
import { scriptExecutablePaths } from "../installers/locations.ts";
export { scriptExecutablePaths } from "../installers/locations.ts";

async function executable(path: string, windows: boolean): Promise<boolean> {
  try {
    // Existence is the only check Windows honors; X_OK is meaningless there.
    await access(path, windows ? constants.F_OK : constants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function executableSync(path: string, windows: boolean): boolean {
  try {
    // Same policy as the async probe: existence on Windows, X_OK elsewhere.
    accessSync(path, windows ? constants.F_OK : constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Windows environment keys are case-insensitive (`Path` vs `PATH`). */
function windowsEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === name && value !== undefined) return value;
  }
  return undefined;
}

/** An extensionless name tries only PATHEXT matches: npm's bin dir pairs an
 * unrunnable extensionless sh shim with each .cmd, and the shim must not win. */
function withExtensions(command: string, extensions: readonly string[]): string[] {
  const base = command.split(/[\\/]/).pop() ?? command;
  if (base.includes(".")) return [command];
  return extensions.map((extension) => `${command}${extension.toLowerCase()}`);
}

/** Windows default search extensions when PATHEXT is unset. */
const defaultPathExt = [".COM", ".EXE", ".BAT", ".CMD"];

/** True for host, Windows, or POSIX absolute paths so injected-platform tests
 * using temp directories work on any host. Real Windows hosts use win32 paths;
 * real POSIX hosts use POSIX paths; either way an absolute directory is kept. */
function isAbsoluteLike(value: string): boolean {
  return isAbsolute(value) || win32.isAbsolute(value) || posix.isAbsolute(value);
}

function isExplicitCommand(command: string): boolean {
  return isAbsoluteLike(command) || command.includes("/") || command.includes("\\");
}

/** Single PATHEXT policy shared by the async and sync Windows lookups. */
function windowsExtensions(env: NodeJS.ProcessEnv): string[] {
  return (windowsEnv(env, "PATHEXT") ?? defaultPathExt.join(win32.delimiter))
    .split(win32.delimiter)
    .filter((part) => part !== "");
}

/** Pure ordered Windows candidates. No filesystem access here; the thin
 * accessSync/statSync and access/stat shells probe the returned list. Host
 * `resolve` is correct on the real host (win32.resolve on Windows) and keeps
 * temp-directory tests working elsewhere; a Windows-absolute entry on a POSIX
 * host simply misses, which is safe. */
function windowsCandidates(command: string, env: NodeJS.ProcessEnv): string[] {
  const extensions = windowsExtensions(env);
  if (isExplicitCommand(command)) return withExtensions(resolve(command), extensions);
  const directories = (windowsEnv(env, "PATH") ?? "").split(win32.delimiter);
  const candidates: string[] = [];
  for (const directory of directories) {
    if (directory === "") continue;
    // Relative PATH entries would resolve against the daemon cwd, letting the
    // cwd win a bare lookup. Windows skips them; POSIX keeps its existing
    // relative handling below to preserve behavior.
    if (!isAbsoluteLike(directory)) continue;
    for (const candidate of withExtensions(resolve(directory, command), extensions)) {
      candidates.push(candidate);
    }
  }
  return candidates;
}

/** Ordered POSIX PATH candidates, preserving empty entries as the cwd. */
function posixPathCandidates(command: string, env: NodeJS.ProcessEnv): string[] {
  const candidates: string[] = [];
  for (const directory of (env["PATH"] ?? "").split(posix.delimiter)) {
    candidates.push(resolve(directory, command));
  }
  return candidates;
}

/** Pure POSIX per-user fallback locations shared by async and sync. */
function posixFallbackCandidates(command: string, env: NodeJS.ProcessEnv): string[] {
  const home = env["HOME"];
  if (!home || !isAbsolute(home)) return [];
  const candidates: string[] = [];
  for (const [name, suffix] of Object.entries(scriptExecutablePaths)) {
    if (command !== name) continue;
    candidates.push(resolve(home, suffix));
  }
  return candidates;
}

async function findWindowsExecutable(
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  for (const candidate of windowsCandidates(command, env)) {
    if (await executable(candidate, true)) return candidate;
  }
  return undefined;
}

function findWindowsExecutableSync(command: string, env: NodeJS.ProcessEnv): string | undefined {
  for (const candidate of windowsCandidates(command, env)) {
    if (executableSync(candidate, true)) return candidate;
  }
  return undefined;
}

async function findPosixExecutable(
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  if (isExplicitCommand(command)) {
    const path = resolve(command);
    return (await executable(path, false)) ? path : undefined;
  }
  const candidates = posixPathCandidates(command, env);
  const found = await Promise.all(candidates.map((candidate) => executable(candidate, false)));
  const path = candidates.find((_, index) => found[index]);
  if (path) return path;
  for (const fallback of posixFallbackCandidates(command, env)) {
    if (await executable(fallback, false)) return fallback;
  }
  return undefined;
}

function findPosixExecutableSync(command: string, env: NodeJS.ProcessEnv): string | undefined {
  if (isExplicitCommand(command)) {
    const path = resolve(command);
    return executableSync(path, false) ? path : undefined;
  }
  for (const candidate of posixPathCandidates(command, env)) {
    if (executableSync(candidate, false)) return candidate;
  }
  for (const fallback of posixFallbackCandidates(command, env)) {
    if (executableSync(fallback, false)) return fallback;
  }
  return undefined;
}

/** Resolve directly, without a shell or a platform-specific `which` subprocess. */
export async function findExecutable(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<string | undefined> {
  if (platform === "win32") return findWindowsExecutable(command, env);
  return findPosixExecutable(command, env);
}

/** Sync variant for startup paths such as TerminalManager open, where an async
 * probe would restructure the call chain. Same PATH/PATHEXT, environment, and
 * executable policy as the async lookup; no shell or subprocess is spawned. */
export function findExecutableSync(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform === "win32") return findWindowsExecutableSync(command, env);
  return findPosixExecutableSync(command, env);
}

/** A package runner cannot establish an already installed, offline agent binding. */
export function isPackageRunner(path: string): boolean {
  return /^(?:npx|uvx|bunx|npm|pnpm|yarn|bun|uv)(?:-cli)?(?:\.(?:cmd|js|cjs|mjs))?$/.test(
    basename(path),
  );
}
