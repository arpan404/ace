import { lstat, realpath } from "node:fs/promises";
import { resolve, relative, isAbsolute, dirname, basename } from "node:path";
import { SettingsError } from "./validation.ts";

export async function workspaceGuard(root: string): Promise<() => Promise<void>> {
  const canonical = await realpath(root);
  return async () => {
    if ((await realpath(root)) !== canonical)
      throw new SettingsError("validation", "Workspace root changed during settings access");
    for (const path of [resolve(canonical, ".ace"), resolve(canonical, ".ace", "settings.json")]) {
      try {
        const info = await lstat(path);
        if (info.isSymbolicLink())
          throw new SettingsError("validation", "Workspace settings cannot use symlink components");
        const actual = await realpath(path);
        const inside = relative(canonical, actual);
        if (inside.startsWith("..") || isAbsolute(inside))
          throw new SettingsError(
            "validation",
            "Workspace settings must stay within the workspace",
          );
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        break;
      }
    }
  };
}

/** Identity outlives the physical-file LRU, so eviction can never reauthorize a moved root. */
export class WorkspaceGuards {
  private roots = new Map<string, Promise<() => Promise<void>>>();
  forFile(path: string): Promise<() => Promise<void>> | undefined {
    if (basename(path) !== "settings.json" || basename(dirname(path)) !== ".ace") return;
    return this.roots.get(dirname(dirname(path)));
  }
  get(root: string): Promise<() => Promise<void>> {
    const path = resolve(root);
    const existing = this.roots.get(path);
    if (existing) return existing;
    if (this.roots.size >= 64)
      return Promise.reject(
        new SettingsError("limit", "Settings workspace identity limit reached"),
      );
    const guard = workspaceGuard(path);
    this.roots.set(path, guard);
    void guard.catch(() => {
      if (this.roots.get(path) === guard) this.roots.delete(path);
    });
    return guard;
  }
  async close(): Promise<void> {
    await Promise.allSettled(this.roots.values());
    this.roots.clear();
  }
}
