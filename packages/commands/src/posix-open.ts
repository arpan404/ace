import {
  closeCommandFd,
  commandLane,
  posix,
  posixOpen,
  rootOf,
  type CommandCalls,
} from "./posix-calls.ts";
import { directoryFlags } from "./posix-flags.ts";
import { EntryUnavailable, type OpenCommandChild } from "./posix-types.ts";
import {
  windowsOpenChild,
  windowsIsLink,
  windowsExists,
  windowsReadLink,
  windowsOpenResolved,
} from "./handle-paths.ts";

export const openCommandChild: OpenCommandChild = async (directory, name, flags, owner) => {
  if (process.platform === "win32") return windowsOpenChild(directory, name);
  const root = rootOf(directory, owner);
  const handle = await posixOpen(
    root,
    (result) => ({ op: "open", directory, name, flags, handle: result }),
    owner,
  );
  if (handle < 0)
    throw new EntryUnavailable("Cannot open command entry without following symlinks");
  return handle;
};
/**
 * An absolute directory path opened from `/` in one call on `root`'s thread, with O_NOFOLLOW at
 * every component: a component swapped for a symlink fails closed.
 */
export async function openCommandPath(
  root: string,
  path: string,
  owner?: CommandCalls,
): Promise<number> {
  if (process.platform === "win32") return windowsOpenResolved(openCommandChild, path);
  const handle = await posixOpen(
    root,
    (result) => ({ op: "openPath", path, handle: result }),
    owner,
  );
  if (handle < 0) throw new EntryUnavailable("Cannot open command folder without following links");
  return handle;
}
/** Read the link itself relative to the pinned skill directory, never its target. */
export async function readCommandLink(
  directory: number,
  name: string,
  owner?: CommandCalls,
): Promise<string> {
  if (process.platform === "win32") return windowsReadLink(directory, name);
  const text = await posix({ op: "readLink", directory, name }, directory, owner);
  if (typeof text !== "string") throw new EntryUnavailable("Unavailable skill link");
  return text;
}

/**
 * Open an absolute, already-resolved directory path one component at a time from `/`, with
 * O_NOFOLLOW at every step: a component swapped for a symlink fails closed.
 */
export async function openResolvedDirectory(
  openChild: OpenCommandChild,
  path: string,
  owner?: CommandCalls,
  lane = commandLane(path),
): Promise<number> {
  if (process.platform === "win32") return windowsOpenResolved(openChild, path);
  // `/` opens on the lane's own thread; everything opened beneath it stays there.
  let fd = await posixOpen(
    lane,
    (handle) => ({ op: "open", directory: -100, name: "/", flags: directoryFlags, handle }),
    owner,
  );
  if (fd < 0) throw new EntryUnavailable("Cannot open /");
  try {
    const parts = path.split("/").filter(Boolean);
    if (parts.length > 128) throw new Error("Trusted root depth limit");
    for (const name of parts) {
      const child = await openChild(fd, name, directoryFlags, owner);
      await closeCommandFd(fd);
      fd = child;
    }
    return fd;
  } catch (error) {
    await closeCommandFd(fd);
    throw error;
  }
}

/**
 * Windows: whether anything, link or not, is called `name` in the pinned directory, asked through
 * the handle. Link reads need the folder's path, which fails once the folder has moved.
 */
export async function commandEntryExists(directory: number, name: string): Promise<boolean> {
  if (process.platform !== "win32") throw new Error("Only Windows asks through the handle");
  return windowsExists(directory, name);
}
/** Windows: whether `name` in the pinned directory is a link, asked through the handle alone. */
export async function commandEntryIsLink(directory: number, name: string): Promise<boolean> {
  if (process.platform !== "win32") throw new Error("Only Windows asks through the handle");
  try {
    return windowsIsLink(directory, name);
  } catch {
    return false;
  }
}
