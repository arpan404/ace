import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { win32 } from "node:path";
import { promisify } from "node:util";

/** Windows environment names ignore case (`Path`, `PATH`). */
function variable(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const upper = name.toUpperCase();
  return Object.entries(env).find(([key, value]) => key.toUpperCase() === upper && value)?.[1];
}

/** A drive-letter path (`C:\…`): not relative, drive-relative, rooted or a network share. */
function localAbsolute(path: string): boolean {
  return /^[a-z]:\\/i.test(path);
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Windows: the installed `tailscale.exe`, by absolute path. Tailscale's installer puts it in
 * `%ProgramFiles%\Tailscale`, which only administrators can write, so that copy wins over any
 * `tailscale.exe` on PATH. Without it, the first `tailscale.exe` in a local absolute PATH folder
 * (a per-user install). Never a bare name, which Windows could resolve from the daemon's working
 * folder, and never a `.cmd` or `.bat`, which `execFile` can't start. Undefined when none exists.
 */
export async function findTailscaleExe(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const installs = ["ProgramW6432", "ProgramFiles"]
    .map((name) => variable(env, name))
    .filter((folder): folder is string => !!folder && localAbsolute(folder))
    .map((folder) => win32.join(folder, "Tailscale", "tailscale.exe"));
  const onPath = (variable(env, "PATH") ?? "")
    .split(";")
    .map((folder) => folder.trim().replace(/^"(.*)"$/, "$1"))
    .filter(localAbsolute)
    .map((folder) => win32.join(folder, "tailscale.exe"));
  for (const candidate of [...installs, ...onPath]) if (await isFile(candidate)) return candidate;
  return undefined;
}

/** Runs the installed `tailscale.exe` without a console window; its stdout. */
export async function runTailscale(
  env: NodeJS.ProcessEnv,
  args: string[],
  timeout: number,
): Promise<string> {
  // Looked up on every call, so installing Tailscale needs no daemon restart.
  const command = await findTailscaleExe(env);
  if (!command)
    throw new Error(
      "Tailscale isn't installed: no tailscale.exe in %ProgramFiles%\\Tailscale or on PATH. Install Tailscale for Windows and connect it.",
    );
  return (
    await promisify(execFile)(command, args, { timeout, maxBuffer: 1024 * 1024, windowsHide: true })
  ).stdout;
}
