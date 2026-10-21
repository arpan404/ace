import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { basename, delimiter, isAbsolute, resolve } from "node:path";
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

async function findWindowsExecutable(
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const extensions = (windowsEnv(env, "PATHEXT") ?? defaultPathExt.join(";"))
    .split(";")
    .filter((part) => part !== "");
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    for (const candidate of withExtensions(resolve(command), extensions)) {
      if (await executable(candidate, true)) return candidate;
    }
    return undefined;
  }
  const directories = (windowsEnv(env, "PATH") ?? "").split(";");
  for (const directory of directories) {
    if (directory === "") continue;
    for (const candidate of withExtensions(resolve(directory, command), extensions)) {
      if (await executable(candidate, true)) return candidate;
    }
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
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    const path = resolve(command);
    return (await executable(path, false)) ? path : undefined;
  }
  const candidates = (env["PATH"] ?? "")
    .split(delimiter)
    .map((directory) => resolve(directory, command));
  const found = await Promise.all(candidates.map((candidate) => executable(candidate, false)));
  const path = candidates.find((_, index) => found[index]);
  if (path) return path;
  const home = env["HOME"];
  if (home && isAbsolute(home)) {
    for (const [name, suffix] of Object.entries(scriptExecutablePaths)) {
      if (command !== name) continue;
      const fallback = resolve(home, suffix);
      if (await executable(fallback, false)) return fallback;
    }
  }
  return undefined;
}

/** A package runner cannot establish an already installed, offline agent binding. */
export function isPackageRunner(path: string): boolean {
  return /^(?:npx|uvx|bunx|npm|pnpm|yarn|bun|uv)(?:-cli)?(?:\.(?:cmd|js|cjs|mjs))?$/.test(
    basename(path),
  );
}
