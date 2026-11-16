import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  inspectSuit,
  problem,
  plan,
  type InspectedSuit,
  type SuitEntry,
  type SuitPlan,
} from "@ace/suits/folder";

/*
 * The disk side of a Suit's folder: an lstat walk that never follows a link, and reads of the
 * files `plan` allows, each opened without following a link either. Everything it decides comes
 * from `@ace/suits/folder`.
 */

export interface SuitWalk {
  entries: SuitEntry[];
  /** Changes whenever any entry's kind, size or modification time does. */
  signature: string;
}

/** Entries under `folder`, depth-first; undefined when the folder isn't there. */
export async function walkSuit(folder: string, maxEntries: number): Promise<SuitWalk | undefined> {
  const entries: SuitEntry[] = [];
  const marks: string[] = [];
  const visit = async (relative: string, depth: number): Promise<void> => {
    const names = await readdir(relative ? join(folder, relative) : folder);
    for (const name of names.toSorted()) {
      if (entries.length >= maxEntries) return;
      const path = relative ? `${relative}/${name}` : name;
      const stat = await lstat(join(folder, path));
      const kind = stat.isSymbolicLink()
        ? "symlink"
        : stat.isDirectory()
          ? "directory"
          : stat.isFile()
            ? "file"
            : "other";
      entries.push({
        path,
        kind,
        size: kind === "file" ? stat.size : 0,
        mtimeMs: stat.mtimeMs,
      });
      marks.push(`${path}\u0000${kind}\u0000${stat.size}\u0000${stat.mtimeMs}`);
      if (kind === "directory" && depth < 16) await visit(path, depth + 1);
    }
  };
  try {
    await visit("", 0);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  return { entries, signature: marks.join("\n") };
}

export const isMissing = (error: unknown) =>
  error instanceof Error &&
  "code" in error &&
  (error.code === "ENOENT" || error.code === "ENOTDIR");

/** One file inside `folder`, opened without following a link and read up to `limit` bytes. */
export async function readSuitFile(folder: string, path: string, limit: number): Promise<Buffer> {
  const handle = await open(join(folder, path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error(`${path} is not a readable file`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export interface ReadSuit {
  inspected: InspectedSuit;
  plan: SuitPlan;
  signature: string;
}

/**
 * A Suit's folder read and checked; undefined when there is no folder `id` under `root`. When
 * nothing in the folder changed since `previous` (same signature), `previous` is the answer and
 * no file is read again.
 */
export async function readSuit(
  root: string,
  id: string,
  limit: number,
  previous?: ReadSuit,
): Promise<ReadSuit | undefined> {
  const folder = join(root, id);
  let top;
  try {
    top = await lstat(folder);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  if (!top.isDirectory()) {
    const walk: SuitPlan = {
      read: [],
      skipped: [],
      stream: [],
      problems: [problem("schema", `${id} is not a folder (a link or a file); a Suit is a folder`)],
    };
    return {
      inspected: inspectSuit(id, new Map(), walk),
      plan: walk,
      signature: `top\u0000${top.isSymbolicLink()}\u0000${top.mtimeMs}`,
    };
  }
  const walk = await walkSuit(folder, 4096);
  if (!walk) return undefined;
  if (previous?.signature === walk.signature) return previous;
  const allowed = plan(walk.entries);
  const files = new Map<string, Uint8Array>();
  for (const path of allowed.read) files.set(path, await readSuitFile(folder, path, limit));
  return { inspected: inspectSuit(id, files, allowed), plan: allowed, signature: walk.signature };
}
