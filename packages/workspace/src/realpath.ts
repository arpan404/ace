import { lstat, readlink, realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { errorCode } from "./types.ts";

// The most links one resolution follows, as POSIX systems allow before ELOOP.
const LINK_LIMIT = 40;

/**
 * realpath that also resolves a leaf this process may not open. Bun opens the final component to
 * resolve it, so a file or folder without read permission (mode 000, write- or execute-only)
 * fails with EACCES where realpath(3) succeeds. Only then is the path resolved here: the parent
 * through realpath, and a symbolic link leaf by reading it.
 */
export async function canonicalPath(path: string): Promise<string> {
  return resolvePath(path, 0);
}

async function resolvePath(path: string, links: number): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (errorCode(error) !== "EACCES") throw error;
    const parent = dirname(path);
    // The root itself, or a path whose parent can't be searched, really is inaccessible.
    if (parent === path) throw error;
    const info = await lstat(path).catch(() => {
      throw error;
    });
    const directory = await resolvePath(parent, links);
    if (!info.isSymbolicLink()) return resolve(directory, basename(path));
    if (links >= LINK_LIMIT)
      throw Object.assign(new Error(`Too many symbolic links: ${path}`), { code: "ELOOP" });
    return resolvePath(resolve(directory, await readlink(path)), links + 1);
  }
}
