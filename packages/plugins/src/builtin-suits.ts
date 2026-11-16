import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { packFolder, unpackArchive } from "@ace/files";

// Resolved on use, like the shipped skills; the release bundle copies the folder beside it.
const shippedRoot = () => fileURLToPath(new URL("../builtin-suits", import.meta.url));

/** Ids of the shipped Suits already offered to this library, one per line. */
const recordName = ".shipped";

/** A shipped Suit packed into one file by `packBuiltinSuits`. */
const packed = ".tar";

/**
 * Copies into a person's Suit library (ADR 0150) each Suit ace ships that this library hasn't
 * been offered yet, so a Suit added in a later release still arrives. A shipped Suit the person
 * later edits or removes is theirs and is never copied back, and a folder already holding that
 * id is left alone. A run that fails part-way records only what it finished, so the next start
 * retries the rest. Returns the ids it copied.
 *
 * The shipped root holds each Suit as a folder (the repo) or as `<id>.tar` (a release, see
 * `packBuiltinSuits`).
 */
export async function seedBuiltinSuits(library: string, root = shippedRoot()): Promise<string[]> {
  await mkdir(library, { recursive: true });
  const offered = await readOffered(library);
  const present = new Set(await readdir(library));
  const shipped = (await readdir(root, { withFileTypes: true }))
    .map((entry) => ({
      id: shippedId(entry),
      path: join(root, entry.name),
      folder: entry.isDirectory(),
    }))
    .filter(
      (suit): suit is { id: string; path: string; folder: boolean } =>
        suit.id !== undefined && !offered.has(suit.id),
    )
    .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const copied: string[] = [];
  try {
    for (const suit of shipped) {
      if (!present.has(suit.id)) {
        // Copied whole under a dot name the library ignores, then moved in, so a crash never
        // leaves a half-copied Suit that would be recorded as offered.
        const staging = join(library, `.seeding-${suit.id}`);
        await rm(staging, { recursive: true, force: true });
        if (suit.folder) await cp(suit.path, staging, { recursive: true });
        else {
          await mkdir(staging);
          await unpackArchive(suit.path, staging);
        }
        await rename(staging, join(library, suit.id));
        copied.push(suit.id);
      }
      offered.add(suit.id);
    }
  } finally {
    if (shipped.length > 0) await writeOffered(library, offered);
  }
  return copied;
}

/**
 * Writes each shipped Suit folder into `output` as one `<id>.tar`, for the release archive:
 * installed updaters refuse an archive over their entry budget (`releaseArchiveLimits` in
 * `@ace/service`), and a Suit's fonts and thumbnails would otherwise be an entry each.
 */
export async function packBuiltinSuits(output: string, root = shippedRoot()): Promise<string[]> {
  await mkdir(output, { recursive: true });
  const ids = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted();
  for (const id of ids) await packFolder(join(root, id), join(output, id + packed));
  return ids;
}

function shippedId(entry: Dirent): string | undefined {
  if (entry.isDirectory()) return entry.name;
  if (entry.isFile() && entry.name.endsWith(packed)) return entry.name.slice(0, -packed.length);
  return undefined;
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
