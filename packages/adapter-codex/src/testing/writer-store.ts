import { mkdirSync, openSync, closeSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/** Optional cross-process writer exclusion for the offline Codex CLI. */
export function writerStore(root: string | undefined) {
  const owned = new Set<string>();
  if (root) mkdirSync(root, { recursive: true });
  process.once("exit", () => {
    for (const path of owned) {
      try {
        unlinkSync(path);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
        throw error;
      }
    }
  });
  return {
    acquire(thread: string): boolean {
      if (!root) return true;
      const path = join(root, `${encodeURIComponent(thread)}.writer`);
      try {
        closeSync(openSync(path, "wx"));
        owned.add(path);
        return true;
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "EEXIST") return false;
        throw error;
      }
    },
    release(thread: string): void {
      if (!root) return;
      const path = join(root, `${encodeURIComponent(thread)}.writer`);
      if (!owned.delete(path)) return;
      unlinkSync(path);
    },
  };
}
