import { lstat, readdir, readlink, realpath } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { errorCode } from "./types.ts";

// The most links one resolution follows, as POSIX systems allow before ELOOP.
const LINK_LIMIT = 40;

/**
 * realpath that also resolves a leaf this process may not open. Bun opens the final component to
 * resolve it, so a file or folder without read permission (mode 000, write- or execute-only)
 * fails with EACCES where realpath(3) succeeds. Only then is the leaf resolved here: its parent
 * through realpath, a symbolic link by reading it, and its name as its parent lists it.
 *
 * Windows never takes this path: callers there rely on realpath for long names and 8.3 aliases.
 */
export async function canonicalPath(path: string): Promise<string> {
  if (process.platform === "win32") return realpath(path);
  return resolvePath(path, 0);
}

async function resolvePath(path: string, links: number): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (errorCode(error) !== "EACCES") throw error;
    // dirname and basename split the path as written, without normalising `..`, so the parent
    // goes to realpath with its links still unresolved.
    const parent = dirname(path);
    const leaf = basename(path);
    // The root itself really is inaccessible.
    if (parent === path) throw error;
    const directory = await resolvePath(parent, links);
    if (leaf === "." || leaf === "") return directory;
    // `directory` is canonical, so going up from it is exact.
    if (leaf === "..") return dirname(directory);
    const info = await lstat(path).catch(() => {
      throw error;
    });
    if (info.isSymbolicLink()) {
      if (links >= LINK_LIMIT)
        throw Object.assign(new Error(`Too many symbolic links: ${path}`), { code: "ELOOP" });
      const target = await readlink(path);
      // The target is joined as written: a `..` in it applies after any link before it.
      return resolvePath(target.startsWith("/") ? target : `${directory}/${target}`, links + 1);
    }
    return `${directory === "/" ? "" : directory}/${await listedName(directory, leaf, error)}`;
  }
}

/**
 * The leaf as its folder names it. A case-insensitive volume finds "Readme" through "README";
 * realpath(3) answers with the stored spelling, and so does this. A folder that can't be listed
 * can't confirm the spelling, so the original failure stands.
 */
async function listedName(directory: string, leaf: string, failure: unknown): Promise<string> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    throw failure;
  }
  if (names.includes(leaf)) return leaf;
  const wanted = fold(leaf);
  const match = names.find((name) => fold(name) === wanted);
  if (match === undefined) throw failure;
  return match;
}

function fold(name: string): string {
  return name.normalize("NFC").toLowerCase();
}
