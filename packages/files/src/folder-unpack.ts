import { close, createReadStream, fchmod, futimes, write } from "node:fs";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { PinnedDirectory } from "@ace/workspace/pinned-directory";
import tar from "tar-stream";
import { z } from "zod";
import { checkAborted, FolderArchiveError } from "./folder-errors.ts";
import { linkRoute, validMemberName } from "./folder-link.ts";

const writeAt = promisify(write);
const closeFd = promisify(close);
const chmodFd = promisify(fchmod);
const timesFd = promisify(futimes);

// Only what packFolder writes. Anything else (devices, hard links, global or unknown PAX
// keys) is refused rather than interpreted.
const PAX_KEYS = new Set(["path", "linkpath", "size", "mtime"]);
const Header = z.object({
  name: z.string(),
  type: z.string().nullish(),
  size: z.number().int().nonnegative().nullish(),
  mode: z.number().int().nonnegative().nullish(),
  mtime: z.date().nullish(),
  linkname: z.string().nullish(),
  pax: z.record(z.string(), z.string()).nullish(),
});
type Header = z.infer<typeof Header>;
/** The part of tar-stream's entry stream this module relies on. */
interface EntryStream extends AsyncIterable<unknown> {
  resume(): unknown;
}

function unsafe(message: string, path: string): FolderArchiveError {
  return new FolderArchiveError("UNSAFE_ENTRY", message, path);
}
function parentOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}
function nameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
function seconds(header: Header): number | undefined {
  const pax = header.pax?.mtime === undefined ? Number.NaN : Number(header.pax.mtime);
  if (Number.isFinite(pax)) return pax;
  return header.mtime ? header.mtime.getTime() / 1000 : undefined;
}

/** Directories this unpack created, reopened from the pinned root one component at a time. */
class Tree {
  private readonly root: PinnedDirectory;
  private readonly made = new Map<string, { dev: number; ino: number }>();
  private open: { path: string; directory: PinnedDirectory } | undefined;
  constructor(root: PinnedDirectory) {
    this.root = root;
  }
  has(path: string): boolean {
    return path === "" || this.made.has(path);
  }
  directory(path: string): PinnedDirectory {
    if (path === "") return this.root;
    if (this.open?.path === path) return this.open.directory;
    this.release();
    let current = this.root;
    let prefix = "";
    try {
      for (const part of path.split("/")) {
        prefix = prefix ? `${prefix}/${part}` : part;
        const next = current.child(part);
        if (current !== this.root) current.closeSync();
        current = next;
        const info = current.stat();
        const made = this.made.get(prefix);
        if (!made || made.dev !== info.dev || made.ino !== info.ino)
          throw new FolderArchiveError("CHANGED", "Destination changed during unpack", prefix);
      }
    } catch (error) {
      if (current !== this.root) current.closeSync();
      throw error;
    }
    this.open = { path, directory: current };
    return current;
  }
  async mkdir(path: string, mode: number): Promise<void> {
    const created = this.directory(parentOf(path)).mkdir(nameOf(path));
    try {
      const info = created.stat();
      await chmodFd(created.fd, mode);
      this.made.set(path, { dev: info.dev, ino: info.ino });
    } finally {
      created.closeSync();
    }
  }
  release(): void {
    this.open?.directory.closeSync();
    this.open = undefined;
  }
}

async function writeFile(
  tree: Tree,
  path: string,
  header: Header,
  stream: EntryStream,
  signal?: AbortSignal,
) {
  const fd = tree.directory(parentOf(path)).createExclusive(nameOf(path));
  try {
    let position = 0;
    for await (const chunk of stream) {
      checkAborted(signal);
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesWritten } = await writeAt(fd, bytes, offset, bytes.length - offset, position);
        offset += bytesWritten;
        position += bytesWritten;
      }
    }
    if (position !== (header.size ?? 0)) throw unsafe("Archive entry is truncated", path);
    await chmodFd(fd, (header.mode ?? 0o644) & 0o755);
    const mtime = seconds(header);
    if (mtime !== undefined) await timesFd(fd, mtime, mtime);
  } finally {
    await closeFd(fd);
  }
}

/**
 * Extracts a folder archive into `destination`, an existing empty directory the caller made.
 * Every write goes through descriptors opened from the destination without following links,
 * and links are created last, after every target has been checked. On failure the
 * destination may hold a partial copy; nothing is ever written outside it.
 */
export async function unpackArchive(
  file: string,
  destination: string,
  options: { signal?: AbortSignal } = {},
): Promise<{ entries: number }> {
  const { signal } = options;
  checkAborted(signal);
  const root = PinnedDirectory.atBoundary(destination);
  const tree = new Tree(root);
  const seen = new Set<string>();
  const links = new Map<string, string>();
  let entries = 0;
  try {
    if (!root.stat().isDirectory() || !root.empty())
      throw new FolderArchiveError("NOT_EMPTY", "Destination must be an empty directory");
    const extract = tar.extract();
    const member = async (raw: unknown, stream: EntryStream) => {
      checkAborted(signal);
      const parsed = Header.safeParse(raw);
      if (!parsed.success) throw unsafe("Archive entry header is malformed", "");
      const header = parsed.data;
      const type = header.type ?? "unknown";
      const path = type === "directory" ? header.name.replace(/\/$/, "") : header.name;
      if (!validMemberName(path)) throw unsafe("Archive entry path is not allowed", path);
      for (const key of Object.keys(header.pax ?? {}))
        if (!PAX_KEYS.has(key)) throw unsafe(`Archive entry uses PAX key ${key}`, path);
      if (seen.has(path)) throw unsafe("Archive entry appears twice", path);
      seen.add(path);
      const parent = parentOf(path);
      for (let above = parent; above; above = parentOf(above))
        if (links.has(above)) throw unsafe("Archive entry goes through a link", path);
      if (!tree.has(parent)) throw unsafe("Archive entry has no parent directory", path);
      if (type !== "file" && (header.size ?? 0) !== 0)
        throw unsafe("Archive entry carries unexpected data", path);
      if (type === "file") await writeFile(tree, path, header, stream, signal);
      else if (type === "directory")
        await tree.mkdir(path, ((header.mode ?? 0o755) & 0o755) | 0o700);
      else if (type === "symlink") {
        if (!header.linkname) throw unsafe("Archive link has no target", path);
        links.set(path, header.linkname);
      } else throw unsafe(`Archive entry type ${type} is not allowed`, path);
      entries++;
    };
    extract.on("entry", (header, stream, next) => {
      member(header, stream).then(
        () => {
          stream.resume();
          next();
        },
        (error: unknown) =>
          extract.destroy(error instanceof Error ? error : new Error(String(error))),
      );
    });
    await pipeline(createReadStream(file), extract, signal ? { signal } : {});
    for (const [path, target] of links) {
      const route = linkRoute(path, target);
      if (!route || route.some((directory) => links.has(directory)))
        throw unsafe("Archive link points outside the folder", path);
    }
    for (const [path, target] of links) {
      checkAborted(signal);
      tree.directory(parentOf(path)).symlink(target, nameOf(path));
    }
    return { entries };
  } catch (error) {
    if (error instanceof FolderArchiveError) throw error;
    if (error instanceof Error && error.name === "AbortError")
      throw new FolderArchiveError("ABORTED", "Folder archive cancelled");
    // Filesystem failures carry a code; anything else came from parsing the tar itself.
    if (error instanceof Error && !("code" in error))
      throw new FolderArchiveError("UNSAFE_ENTRY", `Archive is malformed (${error.message})`);
    throw error;
  } finally {
    tree.release();
    root.closeSync();
  }
}
