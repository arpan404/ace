import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { delimiter } from "node:path";

const marker = "__ACE_PATH__";

/**
 * GUI apps on macOS and many Linux desktops start with a minimal PATH (`/usr/bin:/bin`), so
 * provider CLIs installed by Homebrew, npm or installers are invisible. Ask the user's login
 * shell once for its PATH. Allow slow shell startup before selecting an installation. Falls back to the current PATH on any failure.
 */
export function loginShellPath(env: NodeJS.ProcessEnv, timeoutMs = 10_000): Promise<string> {
  const current = env.PATH ?? "";
  if (process.platform === "win32") return Promise.resolve(current);
  const shell = env.SHELL || "/bin/sh";
  return new Promise((resolve) => {
    execFile(
      shell,
      ["-ilc", `printf '%s%s%s' ${marker} "$PATH" ${marker}`],
      { timeout: timeoutMs, env: { ...env, TERM: "dumb" }, encoding: "utf8" },
      (error, stdout) => {
        const found = error ? undefined : stdout.split(marker)[1];
        resolve(found ? mergePaths(found, current) : current);
      },
    );
  });
}

/** Login-shell entries first, then anything only the current environment had. */
export function mergePaths(...paths: string[]): string {
  const seen = new Set<string>();
  for (const path of paths) for (const entry of path.split(delimiter)) if (entry) seen.add(entry);
  return [...seen].join(delimiter);
}

/**
 * The login shell's PATH saved by the last launch (`spawn-path.ts`), in the app's data folder.
 * Undefined when there is none or it is unreadable: the launch then waits for the shell.
 */
export function readSavedPath(file: string): string | undefined {
  try {
    const saved: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof saved !== "object" || saved === null || !("path" in saved)) return undefined;
    return typeof saved.path === "string" && saved.path ? saved.path : undefined;
  } catch {
    return undefined;
  }
}

/** Saves the login shell's PATH for the next launch; a crash mid-write leaves the old file. */
export async function writeSavedPath(file: string, path: string): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ path })}\n`);
  await rename(temporary, file);
}
