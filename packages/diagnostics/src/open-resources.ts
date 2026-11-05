import { readdirSync } from "node:fs";

/**
 * What keeps the process alive and what a leak piles up. Node names its active handles and
 * requests (sockets, timers, files, child processes). Bun reports none, so there the open file
 * descriptors stand in: stdio, SQLite files, sockets and pipes, but no timers. Bun on Windows has
 * neither and reports none.
 */
export function openResources(): readonly string[] {
  if (!Reflect.has(globalThis, "Bun")) return process.getActiveResourcesInfo();
  const directory =
    process.platform === "linux" ? "/proc/self/fd" : process.platform === "darwin" ? "/dev/fd" : "";
  if (!directory) return [];
  try {
    // The listing names the descriptor it reads through as well; that one isn't the daemon's.
    return readdirSync(directory)
      .slice(1)
      .map(() => "FileDescriptor");
  } catch {
    return [];
  }
}
