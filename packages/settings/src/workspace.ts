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

/** The workspace a `<root>/.ace/settings.json` path belongs to, if it has that shape. */
function aliasedRoot(path: string): string | undefined {
  if (basename(path) !== "settings.json" || basename(dirname(path)) !== ".ace") return;
  return dirname(dirname(path));
}

/**
 * Pins each workspace root to the identity it had when first read, least recently used first
 * out. A settings file keeps the pin it was opened with for as long as it is cached, so dropping
 * a root here never reauthorizes a file in use; a root read again after it was dropped is pinned
 * afresh, as on a first visit. A daemon that has seen more roots than this keeps working.
 *
 * A non-workspace settings file (the global one, when ace's data folder is a workspace's `.ace`)
 * borrows that workspace's pin through `forFile`, and may be reopened long after the workspace
 * was last read. The roots such `aliases` name are never dropped, so a reopened alias is still
 * checked against the identity first seen.
 */
export class WorkspaceGuards {
  private roots = new Map<string, Promise<() => Promise<void>>>();
  private readonly kept: ReadonlySet<string>;
  constructor(aliases: readonly string[] = []) {
    this.kept = new Set(aliases.flatMap((path) => aliasedRoot(resolve(path)) ?? []));
  }
  forFile(path: string): Promise<() => Promise<void>> | undefined {
    const root = aliasedRoot(path);
    return root === undefined ? undefined : this.roots.get(root);
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
      for (const seen of this.roots.keys())
        if (!this.kept.has(seen)) {
          this.roots.delete(seen);
          break;
        }
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
