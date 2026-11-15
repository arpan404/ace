import { cp, mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Resolved on use, like the shipped skills; the release bundle copies the folder beside it.
const shippedRoot = () => fileURLToPath(new URL("../builtin-suits", import.meta.url));

/**
 * Seeds a person's Suit library (ADR 0150) with the Suits ace ships, once: only when the
 * library folder does not exist yet. A shipped Suit the person later edits or removes is theirs,
 * and is never copied back. Returns the ids it copied.
 */
export async function seedBuiltinSuits(library: string, root = shippedRoot()): Promise<string[]> {
  await mkdir(dirname(library), { recursive: true });
  try {
    await mkdir(library);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") return [];
    throw error;
  }
  const entries = await readdir(root, { withFileTypes: true });
  const ids = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  for (const id of ids) await cp(join(root, id), join(library, id), { recursive: true });
  return ids.toSorted();
}
