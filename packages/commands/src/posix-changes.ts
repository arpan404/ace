import { constants } from "node:fs";
import { closeSync } from "node:fs";
import { join as joinPath } from "node:path";
import { mkdirAt, openAt, renameAt, unlinkAt } from "@ace/workspace/descriptor";
import {
  closeCommandFd,
  commandRootSettled,
  posix,
  posixInteger,
  posixOpen,
  rootOf,
  type CommandCalls,
} from "./posix-calls.ts";
import { EntryUnavailable } from "./posix-types.ts";
import { openCommandPath } from "./posix-open.ts";
import {
  windowsQuiet,
  windowsAdopt,
  windowsKnownPath,
  windowsRemove,
  windowsRename,
  windowsJunction,
  windowsCreate,
} from "./handle-paths.ts";

/** Small descriptor-relative mutation primitives, shared by prompt file editing. */
export async function createCommandDirectory(
  directory: number,
  name: string,
  owner?: CommandCalls,
): Promise<void> {
  if (process.platform === "win32") return void windowsQuiet(() => mkdirAt(directory, name));
  await posix({ op: "mkdir", directory, name, mode: 0o700 }, directory, owner);
  // The caller opens the result with O_NOFOLLOW, including when mkdir found an existing entry.
}
export async function createCommandFile(
  directory: number,
  name: string,
  owner?: CommandCalls,
): Promise<number> {
  if (process.platform === "win32") {
    const parent = windowsKnownPath(directory) ?? "";
    try {
      return windowsAdopt(openAt(directory, name, windowsCreate).fd, joinPath(parent, name));
    } catch {
      throw new EntryUnavailable("Cannot create prompt file");
    }
  }
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL;
  const root = rootOf(directory, owner);
  const handle = await posixOpen(
    root,
    (result) => ({ op: "create", directory, name, flags, handle: result }),
    owner,
  );
  if (handle < 0) throw new EntryUnavailable("Cannot create prompt file");
  return handle;
}
export async function replaceCommandFile(
  directory: number,
  source: string,
  target: string,
  owner?: CommandCalls,
): Promise<void> {
  if (process.platform === "win32") {
    if (!windowsQuiet(() => renameAt(directory, source, target)))
      throw new Error("Cannot replace prompt file");
    return;
  }
  const renamed = await posixInteger(
    { op: "rename", from: directory, fromName: source, to: directory, toName: target, flags: 0 },
    directory,
    owner,
  );
  if (renamed < 0) throw new Error("Cannot replace prompt file");
}
/**
 * Removes `name` from the directory at `path` in the background, once nothing abandoned under
 * `root` can still land: a change left running there (a cancelled or timed-out save) finishes
 * first, so the file it may still create or rename is the one removed. The folder is reopened by
 * path, never followed through a link, since the handles of an abandoned thread are gone.
 */
export function removeCommandEntryLater(root: string, path: string, name: string): void {
  void (async () => {
    await commandRootSettled(root);
    const parent = await openCommandPath(root, path);
    try {
      await removeCommandEntry(parent, name, false);
    } finally {
      await closeCommandFd(parent);
    }
  })().catch(() => {});
}
export async function linkCommandFile(
  directory: number,
  source: string,
  target: string,
  owner?: CommandCalls,
): Promise<void> {
  if (process.platform === "win32") {
    // No hard links: claim the name exclusively, then replace the claim with the written file.
    if (!windowsQuiet(() => closeSync(openAt(directory, target, windowsCreate).fd)))
      throw new Error("prompt_conflict");
    if (!windowsQuiet(() => renameAt(directory, source, target))) {
      windowsQuiet(() => unlinkAt(directory, target));
      throw new Error("prompt_conflict");
    }
    return;
  }
  const linked = await posixInteger(
    { op: "link", from: directory, fromName: source, to: directory, toName: target, flags: 0 },
    directory,
    owner,
  );
  if (linked < 0) throw new Error("prompt_conflict");
}

// unlinkat's AT_REMOVEDIR, from <fcntl.h>.
const removeDirectoryFlag = process.platform === "darwin" ? 0x80 : 0x200;
/** mkdirat; false when the entry already exists or can't be made. */
export async function makeCommandDirectory(
  directory: number,
  name: string,
  mode: number,
): Promise<boolean> {
  if (process.platform === "win32") return windowsQuiet(() => mkdirAt(directory, name));
  return (await posixInteger({ op: "mkdir", directory, name, mode }, directory)) === 0;
}
/** unlinkat of a file, symlink (never its target) or, with `folder`, an empty directory. */
export async function removeCommandEntry(
  directory: number,
  name: string,
  folder: boolean,
): Promise<boolean> {
  if (process.platform === "win32") return windowsRemove(directory, name, folder);
  const flags = folder ? removeDirectoryFlag : 0;
  return (await posixInteger({ op: "unlink", directory, name, flags }, directory)) === 0;
}
/** renameat between two pinned directories; neither name is followed. */
export async function renameCommandEntry(
  fromDirectory: number,
  from: string,
  toDirectory: number,
  to: string,
): Promise<boolean> {
  if (process.platform === "win32") return windowsRename(fromDirectory, from, toDirectory, to);
  const operation = { from: fromDirectory, fromName: from, to: toDirectory, toName: to };
  return (await posixInteger({ op: "rename", ...operation, flags: 0 }, fromDirectory)) === 0;
}
// RENAME_EXCL / RENAME_SWAP (<stdio.h>, macOS) and RENAME_NOREPLACE / RENAME_EXCHANGE (Linux).
const renameModes =
  process.platform === "darwin" ? { noReplace: 0x4, exchange: 0x2 } : { noReplace: 1, exchange: 2 };
/**
 * `noReplace` moves `from` to `to` only while `to` doesn't exist (plain renameat would replace an
 * empty directory); `exchange` swaps the two entries atomically. Neither name is followed.
 */
export async function renameCommandEntryAs(
  mode: keyof typeof renameModes,
  fromDirectory: number,
  from: string,
  toDirectory: number,
  to: string,
): Promise<boolean> {
  if (process.platform === "win32") {
    // The add-on refuses an existing `to` in the same rename call, with no separate check.
    if (mode === "exchange") return false;
    return windowsRename(fromDirectory, from, toDirectory, to, false);
  }
  const flags = renameModes[mode];
  const operation = { from: fromDirectory, fromName: from, to: toDirectory, toName: to };
  return (await posixInteger({ op: "renameFlags", ...operation, flags }, fromDirectory)) === 0;
}
/** symlinkat: `name` in the pinned directory, storing `target` as text; fails if `name` exists. */
export async function linkCommandEntry(
  target: string,
  directory: number,
  name: string,
): Promise<boolean> {
  if (process.platform === "win32") return windowsJunction(target, directory, name);
  return (await posixInteger({ op: "symlink", target, directory, name }, directory)) === 0;
}

/**
 * Windows has no atomic exchange: `first` and `second` swap through `free`, a name that must not
 * exist, in three no-replace moves. A crash between them leaves each folder at one of the three
 * names, which is why callers pass a name their journal already records.
 */
export async function exchangeCommandEntriesThrough(
  directory: number,
  first: string,
  second: string,
  free: string,
): Promise<boolean> {
  if (process.platform !== "win32") throw new Error("Only Windows swaps through a free name");
  return (
    (await renameCommandEntryAs("noReplace", directory, second, directory, free)) &&
    (await renameCommandEntryAs("noReplace", directory, first, directory, second)) &&
    (await renameCommandEntryAs("noReplace", directory, free, directory, first))
  );
}
