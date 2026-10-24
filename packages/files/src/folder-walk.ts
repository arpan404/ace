import { lstat, opendir, readlink, realpath } from "node:fs/promises";
import { join } from "node:path";
import { PinnedDirectory } from "@ace/workspace/pinned-directory";
import { checkAborted, FolderArchiveError } from "./folder-errors.ts";
import { linkRoute } from "./folder-link.ts";

export interface FolderMember {
  /** Folder-relative path with `/` separators. */
  path: string;
  name: string;
  /** Open directory holding this member; valid until the walk advances. */
  parent: PinnedDirectory;
  kind: "file" | "directory" | "symlink";
  size: number;
  mode: number;
  mtime: number;
  dev: number;
  ino: number;
  link?: string;
}
export interface FolderWalk {
  members: AsyncGenerator<FolderMember>;
  /** Sockets, FIFOs, devices and links that leave the folder. Final once members is drained. */
  skipped(): number;
}

const TYPE = 0o170000;
const KIND = new Map<number, FolderMember["kind"]>([
  [0o100000, "file"],
  [0o040000, "directory"],
  [0o120000, "symlink"],
]);
function code(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}
function vanished(error: unknown): boolean {
  return code(error) === "ENOENT" || code(error) === "ENOTDIR";
}
async function isLink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch (error) {
    if (vanished(error)) return false;
    throw error;
  }
}
/** Names come from the path, then every entry is re-read through the pinned descriptor. */
async function listNames(directory: PinnedDirectory, path: string, relative: string) {
  const pinned = directory.stat();
  const same = async () => {
    const current = await lstat(path);
    return current.dev === pinned.dev && current.ino === pinned.ino;
  };
  if (!(await same())) throw new FolderArchiveError("CHANGED", "Folder changed", relative || ".");
  const names: string[] = [];
  for await (const entry of await opendir(path, { bufferSize: 256 })) names.push(entry.name);
  if (!(await same())) throw new FolderArchiveError("CHANGED", "Folder changed", relative || ".");
  return names.toSorted();
}

/** Deterministic preorder of a whole folder. Links are read as text and never followed. */
export async function walkFolder(root: string, signal?: AbortSignal): Promise<FolderWalk> {
  const canonical = await realpath(root);
  let skipped = 0;
  async function inside(path: string, target: string): Promise<boolean> {
    const route = linkRoute(path, target);
    if (!route) return false;
    for (const directory of route) if (await isLink(join(canonical, directory))) return false;
    return true;
  }
  async function* descend(
    directory: PinnedDirectory,
    relative: string,
  ): AsyncGenerator<FolderMember> {
    const names = await listNames(directory, join(canonical, relative), relative);
    for (const name of names) {
      checkAborted(signal);
      const path = relative ? `${relative}/${name}` : name;
      let info;
      try {
        info = directory.metadata(name);
      } catch (error) {
        if (vanished(error)) continue;
        throw error;
      }
      const kind = KIND.get(info.mode & TYPE);
      if (!kind) {
        skipped++;
        continue;
      }
      const member: FolderMember = {
        path,
        name,
        parent: directory,
        kind,
        size: kind === "file" ? info.size : 0,
        mode: info.mode & 0o7777,
        mtime: info.mtime,
        dev: info.dev,
        ino: info.ino,
      };
      if (kind === "symlink") {
        const target = await readlink(join(canonical, path));
        const after = directory.metadata(name);
        if (after.ino !== info.ino || after.dev !== info.dev)
          throw new FolderArchiveError("CHANGED", "Link changed while reading", path);
        if (!(await inside(path, target))) {
          skipped++;
          continue;
        }
        member.link = target;
      }
      yield member;
      if (kind === "directory") {
        const child = directory.child(name);
        try {
          const opened = child.stat();
          if (opened.ino !== info.ino || opened.dev !== info.dev)
            throw new FolderArchiveError("CHANGED", "Folder changed", path);
          yield* descend(child, path);
        } finally {
          child.closeSync();
        }
      }
    }
  }
  async function* members(): AsyncGenerator<FolderMember> {
    const top = PinnedDirectory.open(canonical);
    try {
      yield* descend(top, "");
    } finally {
      top.closeSync();
    }
  }
  return { members: members(), skipped: () => skipped };
}
