import type { ProcessJournal } from "./process-inventory.ts";
import { setTimeout as delay } from "node:timers/promises";
import { killWindowsTree } from "./windows-tree.ts";

/** Process-global ownership is separate from application-selected shutdown policy. */
const owned = new Map<
  number,
  { stop: (graceMs: number) => Promise<unknown>; destroy: () => void }
>();
let shutdownInstalled = false;
const journals = new Set<ProcessJournal>();
export function observeProcessGroups(journal: ProcessJournal): () => void {
  journals.add(journal);
  return () => journals.delete(journal);
}

export function killGroup(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === "win32") {
    // No process groups exist; reap the tree like every other Windows stop.
    killWindowsTree(pid, true);
    return;
  }
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
  // Negative-pid signals are invalid on Windows; each owner registers the
  // synchronous destroy its platform actually uses to end the tree.
  for (const entry of owned.values()) entry.destroy();
}
export function registerGroup(
  pid: number,
  stop: (graceMs: number) => Promise<unknown>,
  metadata: { name: string; cwd?: string } = { name: "ace-process" },
  destroy?: () => void,
): void {
  const end = destroy ?? (() => killGroup(pid, "SIGKILL"));
  try {
    for (const journal of journals) journal.add(pid, metadata);
  } catch (error) {
    end();
    throw error;
  }
  if (owned.size === 0) process.on("exit", cleanup);
  owned.set(pid, { stop, destroy: end });
}
export function unregisterGroup(pid: number): void {
  owned.delete(pid);
  for (const journal of journals) journal.remove(pid);
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
    void Promise.allSettled([...owned.values()].map((entry) => entry.stop(graceMs))).then(() => {
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

export async function stopOwnedGroups(graceMs = 500): Promise<void> {
  const results = await Promise.allSettled([...owned.values()].map((entry) => entry.stop(graceMs)));
  if (results.some((result) => result.status === "rejected"))
    throw new Error("Some owned process groups could not be stopped");
}
