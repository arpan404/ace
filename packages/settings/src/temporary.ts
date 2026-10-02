import type { FileHandle } from "node:fs/promises";
import { lstat, opendir, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { SettingsError } from "./validation.ts";

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
async function remove(path: string): Promise<void> {
  await unlink(path).catch((error: unknown) => {
    if (!missing(error)) throw error;
  });
}
/** Recover only the original directory by inode; never follow a replacement symlink for cleanup. */
export async function removeTemporary(path: string, owner: FileHandle): Promise<void> {
  const original = await owner.stat({ bigint: true });
  const sameDirectory = (entry: { ino: bigint; dev: bigint }) =>
    entry.ino === original.ino && entry.dev === original.dev;
  const parent = dirname(path);
  try {
    if (sameDirectory(await stat(parent, { bigint: true }))) {
      await remove(path);
      return;
    }
  } catch (error) {
    if (!missing(error)) throw error;
  }
  // A renamed .ace remains a sibling. Recovery is bounded and only runs on failed writes.
  const siblings = await opendir(dirname(parent));
  let inspected = 0;
  for await (const entry of siblings) {
    if (++inspected > 128) break;
    if (!entry.isDirectory()) continue;
    const candidate = join(dirname(parent), entry.name);
    try {
      if (sameDirectory(await lstat(candidate, { bigint: true }))) {
        await remove(join(candidate, basename(path)));
        return;
      }
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  throw new SettingsError("io", "Cannot locate moved settings directory for temporary cleanup");
}
