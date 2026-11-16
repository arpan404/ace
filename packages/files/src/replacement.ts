import type { Stats } from "node:fs";
import { lstat, rename, rm } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type { ExclusiveRename } from "./exclusive-rename.ts";
import { codeOf, FileError, version } from "./types.ts";

export interface Replacement {
  exclusive: ExclusiveRename;
  /** The new file, beside the destination. */
  temp: string;
  /** `dev:ino` of the new file. */
  identity: string;
  destination: string;
  /** The destination version the caller last checked. */
  expected: string;
  /** Names a kept copy of an outside save: unique per publication. */
  id: string;
}

const identityOf = (info: Stats) => `${info.dev}:${info.ino}`;
/** A rename changes ctime and nothing else a version records. */
const content = (value: string) => value.slice(0, value.lastIndexOf(":"));

async function stat(path: string): Promise<Stats | undefined> {
  return lstat(path).catch((error: unknown) => {
    if (codeOf(error) === "ENOENT") return undefined;
    throw error;
  });
}

/** `notes.md` keeps an outside save as `notes.conflict-<id>.md`, next to it. */
export function keptCopyName(destination: string, id: string): string {
  const name = basename(destination);
  const extension = extname(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  return join(dirname(destination), `${stem}.conflict-${id}${extension}`);
}

async function conflict(destination: string): Promise<FileError> {
  const current = await stat(destination);
  return new FileError(
    "CONFLICT",
    "Another program saved this file at the same moment; its version was kept",
    current ? version(current) : null,
  );
}

/**
 * Put `temp` at `destination` only while the destination is still the version the caller
 * checked. Where the OS has an atomic exchange, the two names swap in one step and the file
 * that left the destination is checked afterwards: the expected version is deleted, anything
 * else is a concurrent outside save, which goes back to the destination (the new file returns
 * to `temp`, unpublished) and the call throws `CONFLICT`. If yet another save landed in
 * between, the displaced file is kept as a copy next to the destination instead, so no
 * program's bytes are ever discarded. Without an exchange this is a plain rename, as before.
 */
export async function publishReplacement(replacement: Replacement): Promise<void> {
  const { exclusive, temp, identity, destination, expected, id } = replacement;
  if (!exclusive.exchange) return rename(temp, destination);
  try {
    await exclusive.exchange(temp, destination);
  } catch (error) {
    if (codeOf(error) === "UNSUPPORTED") return rename(temp, destination);
    // The destination was removed after the last check: that is a change too.
    if (codeOf(error) === "NOT_FOUND") throw await conflict(destination);
    throw error;
  }
  const displaced = await stat(temp);
  if (displaced?.isFile() && content(version(displaced)) === content(expected)) {
    // Recheck right before unlinking; a name that changed again is never removed.
    const current = await stat(temp);
    if (current && identityOf(current) === identityOf(displaced)) await rm(temp);
    return;
  }
  if (!displaced) throw await conflict(destination);
  const placed = await stat(destination);
  if (placed && identityOf(placed) === identity) {
    // A failed swap back leaves the outside save at `temp`; it is kept below.
    const swapped = await exclusive.exchange(temp, destination).then(
      () => true,
      () => false,
    );
    const back = swapped ? await stat(temp) : undefined;
    if (back && identityOf(back) === identity) throw await conflict(destination);
  }
  // `temp` holds an outside save that no longer has a name of its own.
  await exclusive.move(temp, keptCopyName(destination, id)).catch(() => {
    // Left under the private name rather than lost: upload cleanup removes only its own inode.
  });
  throw await conflict(destination);
}
