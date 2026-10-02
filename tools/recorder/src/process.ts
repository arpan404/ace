import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Run `<command> --version`-style probes and return trimmed stdout. */
export async function probe(command: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(command, args, { timeout: 30_000 });
  return stdout.trim();
}

export type Spawned = {
  child: ChildProcessWithoutNullStreams;
  /** Resolves when the process exits, for racing against `settled()`. */
  exited: Promise<void>;
  stop(): Promise<void>;
};

/** Spawn a provider process we own, with a stop() that escalates to SIGKILL. */
export function spawnOwned(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
): Spawned {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    await exited;
    clearTimeout(timer);
  };
  return { child, exited, stop };
}

/**
 * Fire `interrupt` once, `delayMs` after the first call to the returned
 * trigger. Used by scenarios that interrupt mid-tool.
 */
export function interruptOnce(delayMs: number | undefined, interrupt: () => void): () => void {
  let armed = delayMs !== undefined;
  return () => {
    if (!armed) return;
    armed = false;
    setTimeout(interrupt, delayMs);
  };
}
