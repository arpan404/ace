import { spawn, type ChildProcess } from "node:child_process";
import { delimiter } from "node:path";
import { z } from "zod";

const marker = "__ACE_PATH__";

/** How long a login shell may take, and how long its processes get to exit once told to stop. */
export interface LoginShellTiming {
  /** The answer is settled by then whatever the shell does. */
  timeoutMs?: number;
  /** Once answered, what is left of the shell's group gets SIGTERM, then SIGKILL this long later. */
  killGraceMs?: number;
}

/**
 * GUI apps on macOS and many Linux desktops start with a minimal PATH (`/usr/bin:/bin`), so
 * provider CLIs installed by Homebrew, npm or installers are invisible. Ask the user's login
 * shell once for its PATH. Allow slow shell startup before selecting an installation. Falls back
 * to the current PATH on any failure, and at the deadline at the latest, even if the shell
 * ignores being stopped. However it ends, nothing the shell started outlives the lookup: its
 * process group is ended (`endProcessGroup`).
 */
export function loginShellPath(
  env: NodeJS.ProcessEnv,
  { timeoutMs = 10_000, killGraceMs = 2_000 }: LoginShellTiming = {},
): Promise<string> {
  const current = env.PATH ?? "";
  if (process.platform === "win32") return Promise.resolve(current);
  const shell = env.SHELL || "/bin/sh";
  return new Promise((resolve) => {
    let done = false;
    let output = "";
    let child: ChildProcess | undefined;
    const finish = (found: string | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      resolve(found ? mergePaths(found, current) : current);
      // A process the profile left holding stdout open must not keep this end of the pipe.
      child?.stdout?.destroy();
      if (child?.pid !== undefined) endProcessGroup(child.pid, killGraceMs);
    };
    const deadline = setTimeout(() => finish(undefined), timeoutMs);
    deadline.unref();
    try {
      // Its own process group, so the stop reaches whatever the shell profile started too.
      child = spawn(shell, ["-ilc", `printf '%s%s%s' ${marker} "$PATH" ${marker}`], {
        env: { ...env, TERM: "dumb" },
        stdio: ["ignore", "pipe", "ignore"],
        detached: true,
      });
    } catch {
      return finish(undefined);
    }
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
      // Answered once both markers are in: a profile that leaves a process holding stdout
      // open must not hold the answer.
      const parts = output.split(marker);
      if (parts.length >= 3) finish(parts[1]);
    });
    child.once("error", () => finish(undefined));
    // All output read (`exit` can come before the last of it).
    child.once("close", () => {
      const parts = output.split(marker);
      finish(parts.length >= 3 ? parts[1] : undefined);
    });
  });
}

/**
 * Ends process group `pgid` whether or not its leader is still running: SIGTERM now, then
 * SIGKILL to the whole group after `graceMs` if any member is left. While members are left this
 * keeps the process alive (it owns them), and an exit before the grace ends kills them at once.
 * A group that is already empty costs nothing.
 */
function endProcessGroup(pgid: number, graceMs: number): void {
  // Signal 0 checks the group still has a member this process may signal.
  const signal = (name: NodeJS.Signals | 0): boolean => {
    try {
      process.kill(-pgid, name);
      return true;
    } catch {
      return false;
    }
  };
  if (!signal("SIGTERM")) return;
  const killNow = () => void signal("SIGKILL");
  process.once("exit", killNow);
  const until = performance.now() + graceMs;
  const watch = setInterval(() => {
    if (signal(0) && performance.now() < until) return;
    signal("SIGKILL");
    clearInterval(watch);
    process.off("exit", killNow);
  }, 50);
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
  timing?: LoginShellTiming,
): Promise<string> {
  return prefixedPath(
    pending.prefix,
    await loginShellPath({ ...env, PATH: pending.inherited }, timing),
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
