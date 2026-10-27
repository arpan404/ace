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
/**
 * Windows: a link target as stored in an archive, with `/` separators. Drive, UNC, rooted and
 * stream targets (junctions read back as `C:\...`) can only leave the folder: undefined.
 */
function windowsLinkTarget(target: string): string | undefined {
  if (target.includes(":") || /^[\\/]/.test(target)) return undefined;
  return target.replaceAll("\\", "/");
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

/** Decides, before a member is stored, that it and everything under it stays out. */
export type FolderPrune = (member: {
  path: string;
  kind: FolderMember["kind"];
  /** A directory's entry names. */
  names?: readonly string[];
}) => boolean;

/**
 * Reads members under one canonical root through pinned descriptors. Links are read as text,
 * never followed, and skipped when they leave the root; sockets, FIFOs and devices are skipped.
 */
export class FolderReader {
  readonly canonical: string;
  private readonly signal: AbortSignal | undefined;
  private readonly prune: FolderPrune | undefined;
  skipped = 0;
  constructor(canonical: string, signal?: AbortSignal, prune?: FolderPrune) {
    this.canonical = canonical;
    this.signal = signal;
    this.prune = prune;
  }
  private async inside(path: string, target: string): Promise<boolean> {
    if (process.platform === "win32") {
      const portable = windowsLinkTarget(target);
      if (portable === undefined) return false;
      target = portable;
    }
    const route = linkRoute(path, target);
    if (!route) return false;
    for (const directory of route) if (await isLink(join(this.canonical, directory))) return false;
    return true;
  }
  /** The member `name` of `directory`, at folder-relative `path`; none when it is skipped. */
  async member(
    directory: PinnedDirectory,
    name: string,
    path: string,
  ): Promise<FolderMember | undefined> {
    checkAborted(this.signal);
    let info;
    try {
      info = directory.metadata(name);
    } catch (error) {
      if (vanished(error)) return undefined;
      throw error;
    }
    const kind = KIND.get(info.mode & TYPE);
    if (!kind) {
      this.skipped++;
      return undefined;
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
      const target = await readlink(join(this.canonical, path));
      const after = directory.metadata(name);
      if (after.ino !== info.ino || after.dev !== info.dev)
        throw new FolderArchiveError("CHANGED", "Link changed while reading", path);
      if (!(await this.inside(path, target))) {
        this.skipped++;
        return undefined;
      }
      member.link = target;
      if (process.platform === "win32") member.link = windowsLinkTarget(target) ?? target;
    }
    return member;
  }
  /** Opens the directory member just read, checking it is still the same inode. */
  open(member: FolderMember): PinnedDirectory {
    const child = member.parent.child(member.name);
    const opened = child.stat();
    if (opened.ino !== member.ino || opened.dev !== member.dev) {
      child.closeSync();
      throw new FolderArchiveError("CHANGED", "Folder changed", member.path);
    }
    return child;
  }
  /** Whether the prune rule keeps `member` out; a directory is judged with its entry names. */
  async pruned(member: FolderMember, child?: PinnedDirectory): Promise<boolean> {
    if (!this.prune) return false;
    const names =
      child && member.kind === "directory"
        ? await listNames(child, join(this.canonical, member.path), member.path)
        : undefined;
    return this.prune({ path: member.path, kind: member.kind, ...(names ? { names } : {}) });
  }
  /** Every member under `directory` (at `relative`), in sorted preorder. */
  async *descend(directory: PinnedDirectory, relative: string): AsyncGenerator<FolderMember> {
    const names = await listNames(directory, join(this.canonical, relative), relative);
    for (const name of names) {
      const path = relative ? `${relative}/${name}` : name;
      const member = await this.member(directory, name, path);
      if (!member) continue;
      if (member.kind !== "directory") {
        if (!(await this.pruned(member))) yield member;
        continue;
      }
      const child = this.open(member);
      try {
        if (await this.pruned(member, child)) continue;
        yield member;
        yield* this.descend(child, path);
      } finally {
        child.closeSync();
      }
    }
  }
}

/**
 * Deterministic preorder of a whole folder, without what `prune` keeps out. Links are read as
 * text and never followed.
 */
export async function walkFolder(
  root: string,
  signal?: AbortSignal,
  prune?: FolderPrune,
): Promise<FolderWalk> {
  const reader = new FolderReader(await realpath(root), signal, prune);
  async function* members(): AsyncGenerator<FolderMember> {
    const top = PinnedDirectory.open(reader.canonical);
    try {
      yield* reader.descend(top, "");
    } finally {
      top.closeSync();
    }
  }
  return { members: members(), skipped: () => reader.skipped };
}
