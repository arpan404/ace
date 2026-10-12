import { createHash } from "node:crypto";
import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";
import { GitError } from "./types.ts";

/** Cold cleanup only. Bound traversal; symlinks contribute their own bytes, never target bytes. */
export async function worktreeFootprint(
  root: string,
): Promise<{ bytes: number; modifiedAt: number; digest: string }> {
  const hash = createHash("sha256");
  let visited = 0,
    bytes = 0,
    modifiedAt = 0;
  const walk = async (path: string, depth: number): Promise<void> => {
    if (++visited > 10000 || depth > 32)
      throw new GitError("output_too_large", "Worktree cleanup scan exceeds its budget");
    const info = await lstat(path);
    hash.update(JSON.stringify([path, info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs]));
    modifiedAt = Math.max(modifiedAt, Math.floor(info.mtimeMs));
    if (info.isDirectory() && !info.isSymbolicLink()) {
      const names: string[] = [];
      for await (const entry of await opendir(path)) {
        if (names.length > 10000)
          throw new GitError("output_too_large", "Worktree directory exceeds its budget");
        names.push(entry.name);
      }
      for (const name of names.toSorted()) await walk(join(path, name), depth + 1);
    } else bytes += info.size;
  };
  await walk(root, 0);
  return { bytes, modifiedAt, digest: hash.digest("hex") };
}
