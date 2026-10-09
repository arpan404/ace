import { lstat } from "node:fs/promises";
import { contains, walkFiles } from "@ace/native-session";
import { join, relative, sep } from "node:path";
import type { ProviderHome } from "./contracts.ts";

export function inventoryRoots(instance: ProviderHome): string[] {
  return instance.provider === "claude"
    ? [join(instance.homeDir, "projects")]
    : instance.provider === "pi"
      ? [join(instance.homeDir, "sessions")]
      : instance.provider === "codex"
        ? [join(instance.homeDir, "sessions"), join(instance.homeDir, "archived_sessions")]
        : [join(instance.homeDir, "storage/session")];
}
export function isRootDatabase(instance: ProviderHome, path: string): boolean {
  const name = relative(instance.homeDir, path);
  return instance.provider === "codex"
    ? /^state_\d+\.sqlite$/.test(name)
    : instance.provider === "opencode" && /^opencode(?:-[\w-]+)?\.db$/.test(name);
}
export function changedRoots(instance: ProviderHome, paths: string[]): string[] {
  const accepted = [...new Set(paths)].toSorted();
  const roots: string[] = [];
  for (const path of accepted) {
    if (
      !contains(instance.homeDir, path) ||
      (!inventoryRoots(instance).some((root) => contains(root, path)) &&
        !isRootDatabase(instance, path))
    )
      throw new Error("Changed history path escaped inventory roots");
    if (!roots.some((root) => path === root || path.startsWith(root + sep))) roots.push(path);
  }
  return roots;
}
export async function* changedFiles(
  path: string,
  signal: AbortSignal,
  budget: { entries: number },
) {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  signal.throwIfAborted();
  if (info.isDirectory()) yield* walkFiles(path, signal, budget);
  else if (info.isFile()) {
    if (++budget.entries > 100000) throw new Error("Session inventory limit exceeded");
    yield path;
  }
}
