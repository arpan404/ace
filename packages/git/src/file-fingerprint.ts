import { lstat } from "node:fs/promises";
import { join } from "node:path";

/**
 * What a checkout path is right now, cheaply: its kind, size, modification and change times and
 * inode, without following a symlink. A discard compares it with what the person reviewed and
 * refuses a file that changed in between. A missing file reads `missing`.
 */
export async function fileFingerprint(root: string, path: string): Promise<string> {
  try {
    const stat = await lstat(join(root, path), { bigint: true });
    const kind = stat.isSymbolicLink() ? "l" : stat.isDirectory() ? "d" : "f";
    return `${kind}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.ino}`;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "missing";
    throw error;
  }
}
