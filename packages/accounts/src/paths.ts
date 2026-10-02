import { realpath, lstat } from "node:fs/promises";
import { resolve, basename, dirname, join } from "node:path";
async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
/** Resolve a not-yet-created destination without writing into a source alias. */
export async function canonicalHome(path: string): Promise<string> {
  let ancestor = resolve(path);
  const missing: string[] = [];
  while (!(await exists(ancestor))) {
    if (missing.length >= 128) throw new Error("Home depth limit exceeded");
    missing.push(basename(ancestor));
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error("Home root does not exist");
    ancestor = parent;
  }
  return join(await realpath(ancestor), ...missing.toReversed());
}
