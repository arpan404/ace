import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import type { PinnedDirectory } from "@ace/workspace";
import { lstat, mkdir, open, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

/** The SHA-256 of a whole file, streamed. */
export async function fileDigest(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, signal ? { signal } : {}))
    hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Bytes a file holds, or 0 when it isn't there. */
export async function fileBytes(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

/** Appends `data` when the file holds exactly `offset` bytes; answers what it holds after. */
export async function appendAt(path: string, offset: number, data: Buffer): Promise<number> {
  const held = await fileBytes(path);
  if (held !== offset) return held;
  const handle = await open(path, "a", 0o600);
  try {
    await handle.write(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return held + data.length;
}

/** Reads `length` bytes of a file from `offset`. */
export async function readAt(path: string, offset: number, length: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
}

export async function removeQuietly(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true }).catch(() => undefined);
}

/** Removes every entry of a transfers directory that `keep` doesn't claim, after a restart. */
export async function removeStray(directory: string, keep: (name: string) => boolean) {
  const names = await readdir(directory).catch(() => []);
  for (const name of names) if (!keep(name)) await removeQuietly(join(directory, name));
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** A folder name for a project there, safe as one path segment. */
export function folderName(name: string): string {
  return (
    name
      .replace(/[/\\\0]/g, "-")
      .replace(/^\.+/, "")
      .trim()
      .slice(0, 128) || "project"
  );
}

/** A free path under `parent` for `name`, checked on disk and against `held`. */
export async function freeFolder(
  parent: string,
  name: string,
  held: ReadonlySet<string>,
): Promise<string> {
  const base = folderName(name);
  for (let n = 1; n < 1000; n++) {
    const candidate = join(parent, n === 1 ? base : `${base}-${n}`);
    if (!held.has(candidate) && !(await exists(candidate))) return candidate;
  }
  throw new Error("No free folder name");
}

/** A folder's identity, `dev:ino`, recorded once a transfer made it. */
export function folderIdentity(info: { dev: number | bigint; ino: number | bigint }): string {
  return `${info.dev}:${info.ino}`;
}

/**
 * Removes `name` from a held parent only while it is still the folder with identity `id`.
 * Answers false when the name is gone or leads somewhere else; a failed removal throws.
 */
/**
 * Windows can't finish removing a folder while a just-stopped child (a cancelled `git clone`)
 * still holds files in it, and its kill lands a moment later. Retry the owned removal briefly;
 * the last failure is the caller's to record.
 */
export async function removeIfOwnedSettling(
  parent: { handle: PinnedDirectory },
  name: string,
  id: string,
  wait: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      removeIfOwned(parent, name, id);
      return;
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      const held = ["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"].includes(String(code));
      if (!held || attempt >= 10) throw error;
      await wait(Math.min(50 * 2 ** attempt, 800));
    }
  }
}
export function removeIfOwned(parent: { handle: PinnedDirectory }, name: string, id: string) {
  let there;
  try {
    there = parent.handle.metadata(name);
  } catch {
    return false;
  }
  if (folderIdentity(there) !== id) return false;
  removeUnder(parent, name);
  return true;
}

/**
 * Removes `name` and everything under it through descriptors from a held parent, never
 * following a link (a link is removed itself). Nothing is ever removed by path: a folder it
 * can't remove that way (one holding more than 10,000 entries can't be listed) fails, and the
 * caller keeps a record of it instead.
 */
export function removeUnder(parent: { handle: PinnedDirectory }, name: string): void {
  removeTree(parent.handle, name);
}

function removeTree(directory: PinnedDirectory, name: string): void {
  if ((directory.metadata(name).mode & constants.S_IFMT) !== constants.S_IFDIR) {
    directory.unlink(name);
    return;
  }
  const child = directory.child(name);
  try {
    for (const entry of child.names()) removeTree(child, entry);
  } finally {
    child.closeSync();
  }
  directory.removeDirectory(name);
}
