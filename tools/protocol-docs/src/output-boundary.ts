import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** The caller owns boundary; every component beneath it must be a real directory. */
export async function ownedOutputRoot(root: string, boundary = dirname(root)): Promise<string> {
  const owner = resolve(boundary);
  const descendant = relative(owner, resolve(root));
  if (
    !descendant ||
    isAbsolute(descendant) ||
    descendant === ".." ||
    descendant.startsWith(`..${sep}`)
  )
    throw new Error(`Output root must be inside its owned boundary: ${root}`);
  let current = await realpath(owner);
  for (const part of descendant.split(sep)) {
    current = join(current, part);
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink())
        throw new Error(`Refusing symlink in generated output: ${current}`);
      if (!entry.isDirectory()) throw new Error(`Generated output must be a directory: ${current}`);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  return current;
}
