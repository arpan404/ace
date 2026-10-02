import { setTimeout as delay } from "node:timers/promises";

/** Process-global ownership is separate from application-selected shutdown policy. */
const owned = new Map<number, (graceMs: number) => Promise<unknown>>();
let shutdownInstalled = false;

export function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Darwin can report EPERM for groups containing only zombies before reaping.
    if (code !== "ESRCH" && !(process.platform === "darwin" && code === "EPERM")) throw error;
  }
}
/** A retained group's lifetime is independent of its leader and inherited pipes. */
export async function stopRetainedGroup(pid: number, graceMs: number): Promise<void> {
  killGroup(pid, "SIGTERM");
  const deadline = performance.now() + graceMs;
  while (true) {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH" || (process.platform === "darwin" && code === "EPERM")) break;
      throw error;
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      killGroup(pid, "SIGKILL");
      break;
    }
    await delay(Math.min(25, remaining));
  }
  unregisterGroup(pid);
}
function cleanup(): void {
  for (const pid of owned.keys()) killGroup(pid, "SIGKILL");
}
export function registerGroup(pid: number, stop: (graceMs: number) => Promise<unknown>): void {
  if (owned.size === 0) process.on("exit", cleanup);
  owned.set(pid, stop);
}
export function unregisterGroup(pid: number): void {
  owned.delete(pid);
  if (owned.size === 0) process.removeListener("exit", cleanup);
}

/** Opt into graceful process termination. Dispose to restore application ownership. */
export function installShutdownHandlers({
  graceMs = 5_000,
}: { graceMs?: number } = {}): () => void {
  if (!Number.isFinite(graceMs) || graceMs < 0) throw new RangeError("Invalid graceMs");
  if (shutdownInstalled) throw new Error("Shutdown handlers are already installed");
  shutdownInstalled = true;
  let terminating = false;
  const dispose = () => {
    process.removeListener("SIGINT", onInt);
    process.removeListener("SIGTERM", onTerm);
    shutdownInstalled = false;
  };
  const terminate = (signal: NodeJS.Signals) => {
    if (terminating) return;
    terminating = true;
    void Promise.allSettled([...owned.values()].map((stop) => stop(graceMs))).then(() => {
      dispose();
      // Incoming application handlers have run; restore default signal termination.
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    });
  };
  const onInt = () => terminate("SIGINT");
  const onTerm = () => terminate("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  return dispose;
}
