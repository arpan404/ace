import { readdirSync } from "node:fs";

/**
 * What keeps the process alive and what a leak piles up: Node names its active handles and
 * requests. Bun reports none, so there the open file descriptors (sockets, pipes, files) stand in.
 */
export function openResources(): readonly string[] {
  if (!Reflect.has(globalThis, "Bun")) return process.getActiveResourcesInfo();
  const directory =
    process.platform === "linux" ? "/proc/self/fd" : process.platform === "darwin" ? "/dev/fd" : "";
  if (!directory) return [];
  try {
    return readdirSync(directory).map(() => "FileDescriptor");
  } catch {
    return [];
  }
}
