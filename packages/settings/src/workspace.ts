import { lstat, realpath, stat } from "node:fs/promises";
import { resolve, relative, isAbsolute, dirname, basename } from "node:path";
import { SettingsError } from "./validation.ts";

export async function workspaceGuard(root: string): Promise<() => Promise<void>> {
  const canonical = await realpath(root);
  const identity = await stat(canonical, { bigint: true });
  return async () => {
    const current = await stat(root, { bigint: true });
    if (
      (await realpath(root)) !== canonical ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino
    )
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

/** How many workspace roots keep their identity pinned between settings files. */
const pinnedRoots = 64;

/**
 * Pins each workspace root to the identity it had when first read, least recently used first
 * out. A settings file keeps the pin it was opened with for as long as it is cached, so dropping
 * a root here never reauthorizes a file in use; a root read again after it was dropped is pinned
 * afresh, as on a first visit. A daemon that has seen more roots than this keeps working.
 */
export class WorkspaceGuards {
  private roots = new Map<string, Promise<() => Promise<void>>>();
  forFile(path: string): Promise<() => Promise<void>> | undefined {
    if (basename(path) !== "settings.json" || basename(dirname(path)) !== ".ace") return;
    return this.roots.get(dirname(dirname(path)));
  }
  get(root: string): Promise<() => Promise<void>> {
    const path = resolve(root);
    const existing = this.roots.get(path);
    if (existing) {
      this.roots.delete(path);
      this.roots.set(path, existing);
      return existing;
    }
    if (this.roots.size >= pinnedRoots) {
      const oldest = this.roots.keys().next().value;
      if (oldest !== undefined) this.roots.delete(oldest);
    }
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
