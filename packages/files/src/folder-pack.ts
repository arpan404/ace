import { createHash } from "node:crypto";
import { close, read } from "node:fs";
import { open, realpath, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { promisify } from "node:util";
import {
  PinnedDirectory,
  sameFile,
  type FileIdentity,
  type IdentifiedStats,
} from "@ace/workspace/pinned-directory";
import { checkAborted, FolderArchiveError } from "./folder-errors.ts";
import { walkSelected } from "./folder-select.ts";
import { walkFolder, type FolderMember, type FolderPrune, type FolderWalk } from "./folder-walk.ts";
import { tarHeaders } from "./tar.ts";

export interface PackOptions {
  signal?: AbortSignal;
  /** Refuse with `TOO_LARGE` once the archive would grow past this many bytes. */
  maxBytes?: number;
}
export interface PackResult {
  bytes: number;
  sha256: string;
  entries: number;
  /** Sockets, FIFOs, devices and symlinks leaving the folder, which are not stored. */
  skipped: number;
  /** Regular files stored. */
  files: number;
}
export interface FolderMeasure {
  bytes: number;
  entries: number;
  skipped: number;
}

const BUFFER = 1024 * 1024;
const END = 1024;
const readAt = promisify(read);
const closeFd = promisify(close);

function header(member: FolderMember) {
  return tarHeaders({
    name: member.path,
    size: member.size,
    mtime: member.mtime,
    directory: member.kind === "directory",
    mode: member.mode,
    ...(member.link === undefined ? {} : { link: member.link }),
  });
}
function padding(size: number): number {
  return (512 - (size % 512)) % 512;
}

/** Counts what packFolder would write for the folder as it is now, without reading files. */
export async function measureFolder(
  root: string,
  options: { signal?: AbortSignal } = {},
): Promise<FolderMeasure> {
  const walk = await walkFolder(root, options.signal);
  let bytes = END;
  let entries = 0;
  for await (const member of walk.members) {
    for (const block of header(member)) bytes += block.length;
    bytes += member.size + padding(member.size);
    entries++;
  }
  return { bytes, entries, skipped: walk.skipped() };
}

/** Buffers small tar blocks into large writes while hashing and enforcing the size limit. */
class Sink {
  bytes = 0;
  private readonly handle: FileHandle;
  private readonly limit: number;
  private readonly buffer = Buffer.alloc(BUFFER);
  private used = 0;
  private readonly digest = createHash("sha256");
  constructor(handle: FileHandle, limit: number) {
    this.handle = handle;
    this.limit = limit;
  }
  async append(bytes: Buffer): Promise<void> {
    if (this.bytes + bytes.length > this.limit)
      throw new FolderArchiveError("TOO_LARGE", `Folder archive exceeds ${this.limit} bytes`);
    this.bytes += bytes.length;
    this.digest.update(bytes);
    let offset = 0;
    while (offset < bytes.length) {
      const count = bytes.copy(this.buffer, this.used, offset);
      this.used += count;
      offset += count;
      if (this.used === BUFFER) await this.flush();
    }
  }
  async flush(): Promise<void> {
    if (!this.used) return;
    await this.handle.write(this.buffer, 0, this.used);
    this.used = 0;
  }
  sha256(): string {
    return this.digest.digest("hex");
  }
}

async function copyFile(member: FolderMember, sink: Sink, scratch: Buffer, signal?: AbortSignal) {
  let fd: number;
  let opened: IdentifiedStats;
  try {
    ({ fd, info: opened } = member.parent.openReadIdentified(member.name));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EACCES")
      throw new FolderArchiveError("UNREADABLE", "File can't be read", member.path);
    throw error;
  }
  try {
    if (!opened.isFile() || !sameFile(opened.identity, member.identity))
      throw new FolderArchiveError("CHANGED", "File was replaced", member.path);
    let position = 0;
    while (position < member.size) {
      checkAborted(signal);
      const length = Math.min(scratch.length, member.size - position);
      const { bytesRead } = await readAt(fd, scratch, 0, length, position);
      if (!bytesRead) throw new FolderArchiveError("CHANGED", "File shrank", member.path);
      await sink.append(scratch.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await closeFd(fd);
  }
  const pad = padding(member.size);
  if (pad) await sink.append(Buffer.alloc(pad));
}

/**
 * Writes an uncompressed tar of the whole folder to `file`, which must not exist.
 * Dotfiles and ignored files are included; links are stored as text, never followed.
 * The partial file is removed on any failure.
 */
export async function packFolder(
  root: string,
  file: string,
  options: PackOptions = {},
): Promise<PackResult> {
  checkAborted(options.signal);
  return packWalk(await walkFolder(root, options.signal), file, options);
}

/**
 * Writes a tar of only `paths` (folder-relative; a trailing `/` takes a whole directory) and
 * their parent directories, with the same rules as packFolder. `prune` keeps a member and
 * everything under it out.
 */
export async function packFiles(
  root: string,
  paths: readonly string[],
  file: string,
  options: PackOptions & { prune?: FolderPrune } = {},
): Promise<PackResult> {
  checkAborted(options.signal);
  const walk = await walkSelected(root, paths, {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.prune ? { prune: options.prune } : {}),
  });
  return packWalk(walk, file, options);
}

/** The identity of the output file just made, read the same way the walk reads members. */
async function outputIdentity(file: string): Promise<FileIdentity> {
  const parent = PinnedDirectory.open(await realpath(dirname(file)));
  try {
    return parent.fileMetadata(basename(file)).identity;
  } finally {
    parent.closeSync();
  }
}

async function packWalk(walk: FolderWalk, file: string, options: PackOptions): Promise<PackResult> {
  const { signal } = options;
  const handle = await open(file, "wx", 0o600);
  try {
    const output = await outputIdentity(file);
    const sink = new Sink(handle, options.maxBytes ?? Number.POSITIVE_INFINITY);
    const scratch = Buffer.alloc(BUFFER);
    let entries = 0;
    let files = 0;
    let own = 0;
    for await (const member of walk.members) {
      // An output file inside the folder must not copy itself.
      if (sameFile(member.identity, output)) {
        own++;
        continue;
      }
      for (const block of header(member)) await sink.append(block);
      if (member.kind === "file") {
        await copyFile(member, sink, scratch, signal);
        files++;
      }
      entries++;
    }
    await sink.append(Buffer.alloc(END));
    await sink.flush();
    await handle.sync();
    await handle.close();
    return {
      bytes: sink.bytes,
      sha256: sink.sha256(),
      entries,
      files,
      skipped: walk.skipped() + own,
    };
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(file).catch(() => {});
    throw error;
  }
}
