import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Resolved on use, like the shipped skills; the release bundle copies the folder beside it.
const shippedRoot = () => fileURLToPath(new URL("../builtin-suits", import.meta.url));

/** Ids of the shipped Suits already offered to this library, one per line. */
const recordName = ".shipped";

/**
 * Copies into a person's Suit library (ADR 0150) each Suit ace ships that this library hasn't
 * been offered yet, so a Suit added in a later release still arrives. A shipped Suit the person
 * later edits or removes is theirs and is never copied back, and a folder already holding that
 * id is left alone. A run that fails part-way records only what it finished, so the next start
 * retries the rest. Returns the ids it copied.
 */
export async function seedBuiltinSuits(library: string, root = shippedRoot()): Promise<string[]> {
  await mkdir(library, { recursive: true });
  const offered = await readOffered(library);
  const present = new Set(await readdir(library));
  const entries = await readdir(root, { withFileTypes: true });
  const ids = entries
    .filter((entry) => entry.isDirectory() && !offered.has(entry.name))
    .map((entry) => entry.name)
    .toSorted();
  const copied: string[] = [];
  try {
    for (const id of ids) {
      if (!present.has(id)) {
        // Copied whole under a dot name the library ignores, then moved in, so a crash never
        // leaves a half-copied Suit that would be recorded as offered.
        const staging = join(library, `.seeding-${id}`);
        await rm(staging, { recursive: true, force: true });
        await cp(join(root, id), staging, { recursive: true });
        await rename(staging, join(library, id));
        copied.push(id);
      }
      offered.add(id);
    }
  } finally {
    if (ids.length > 0) await writeOffered(library, offered);
  }
  return copied;
}

async function readOffered(library: string): Promise<Set<string>> {
  try {
    const text = await readFile(join(library, recordName), "utf8");
    return new Set(text.split("\n").filter((line) => line.length > 0));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return new Set();
    throw error;
  }
}

async function writeOffered(library: string, offered: Set<string>): Promise<void> {
  const path = join(library, recordName);
  await writeFile(`${path}.tmp`, [...offered].toSorted().join("\n") + "\n");
  await rename(`${path}.tmp`, path);
}
