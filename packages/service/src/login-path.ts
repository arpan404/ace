import { execFile } from "node:child_process";
import { delimiter } from "node:path";
import { z } from "zod";

const marker = "__ACE_PATH__";

/**
 * GUI apps on macOS and many Linux desktops start with a minimal PATH (`/usr/bin:/bin`), so
 * provider CLIs installed by Homebrew, npm or installers are invisible. Ask the user's login
 * shell once for its PATH. Allow slow shell startup before selecting an installation. Falls back
 * to the current PATH on any failure.
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
 * The hand-off between the desktop app and a daemon it spawned on last launch's saved PATH,
 * before the login shell answered. The app sets this variable to a `PendingLoginPath`, then
 * writes the login shell's PATH on the daemon's stdin as one `encodeLoginPathLine` line.
 */
export const loginPathPending = "ACE_LOGIN_PATH_PENDING";

/** What the daemon needs to ask the login shell itself, exactly as the app would. */
export const PendingLoginPath = z.object({
  /** Folders put before the login shell's PATH (the app's bundled tools). */
  prefix: z.string().optional(),
  /** The PATH the app itself started with, merged after the login shell's. */
  inherited: z.string(),
});
export type PendingLoginPath = z.infer<typeof PendingLoginPath>;

/** The daemon's PATH: `prefix` first, then `path`. */
export function prefixedPath(prefix: string | undefined, path: string): string {
  return prefix ? [prefix, path].join(delimiter) : path;
}

/** The daemon's PATH from the login shell's, as the app computes it. */
export async function daemonLoginPath(
  pending: PendingLoginPath,
  env: NodeJS.ProcessEnv,
  timeoutMs?: number,
): Promise<string> {
  return prefixedPath(
    pending.prefix,
    await loginShellPath({ ...env, PATH: pending.inherited }, timeoutMs),
  );
}

/** One line carrying a PATH exactly, whatever characters it holds. */
export function encodeLoginPathLine(path: string): string {
  return `${JSON.stringify(path)}\n`;
}

const LoginPathLine = z.string().min(1);

/** The PATH in one `encodeLoginPathLine` line, or undefined when the line is not one. */
export function decodeLoginPathLine(line: string): string | undefined {
  try {
    const parsed = LoginPathLine.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
