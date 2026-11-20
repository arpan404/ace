import { readdirSync } from "node:fs";
import { constants, setPriority } from "node:os";

/**
 * The priority the processes the daemon starts (provider CLIs, git, toolchains, and the builds
 * and tools they start in turn, which inherit it) run at, so a pile of agent work cannot starve
 * the daemon's event loop (ADR 0195). Any process may lower its own children without privilege.
 *
 * - Linux, macOS and the BSDs: nice 5. The daemon itself stays at 0 (or above, where it may).
 * - Windows: BELOW_NORMAL, which Windows passes on to the child's own children.
 * - Elsewhere: unchanged.
 */
export function childNice(platform: NodeJS.Platform): number | undefined {
  if (platform === "win32") return constants.priority.PRIORITY_BELOW_NORMAL;
  if (platform === "linux" || platform === "darwin" || platform === "freebsd") return 5;
  if (platform === "openbsd" || platform === "netbsd") return 5;
  return undefined;
}

export interface ChildPriorityPort {
  platform: NodeJS.Platform;
  setPriority(pid: number, priority: number): void;
  /** Linux: the thread ids under `/proc/<pid>/task`; nice is per thread there. */
  threads(pid: number): readonly number[];
}

export const systemChildPriority = (platform: NodeJS.Platform): ChildPriorityPort => ({
  platform,
  setPriority: (pid, priority) => setPriority(pid, priority),
  threads(pid) {
    try {
      return readdirSync(`/proc/${pid}/task`).map(Number).filter(Number.isInteger);
    } catch {
      return [];
    }
  },
});

/**
 * Lowers a just-started child to `childNice`. On Linux nice belongs to each thread: the child's
 * threads that already exist are lowered one by one, and the ones it starts later inherit it
 * from the thread that starts them. Never throws: a child that already exited, or a refusal,
 * leaves it as it was. Returns whether the child itself was lowered.
 */
export function lowerChildPriority(pid: number, port: ChildPriorityPort): boolean {
  const nice = childNice(port.platform);
  if (nice === undefined) return false;
  let lowered = false;
  const targets = port.platform === "linux" ? new Set([pid, ...port.threads(pid)]) : [pid];
  for (const target of targets) {
    try {
      port.setPriority(target, nice);
      if (target === pid) lowered = true;
    } catch {
      // Exited already, or the OS refused: it keeps the daemon's priority.
    }
  }
  return lowered;
}
