import { close, createReadStream, fchmod, futimes, write } from "node:fs";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
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
function code(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}
function seconds(header: Header): number | undefined {
  const pax = header.pax?.mtime === undefined ? Number.NaN : Number(header.pax.mtime);
  if (Number.isFinite(pax)) return pax;
  return header.mtime ? header.mtime.getTime() / 1000 : undefined;
}

/**
 * Directories this unpack created (or, merging, found already there), reopened from the pinned
 * root one component at a time.
 */
class Tree {
  private readonly root: PinnedDirectory;
  private readonly merging: boolean;
  private readonly made = new Map<string, { dev: number; ino: number }>();
  private open: { path: string; directory: PinnedDirectory } | undefined;
  constructor(root: PinnedDirectory, merging: boolean) {
    this.root = root;
    this.merging = merging;
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
  /** Makes a directory; merging, an existing one is used as it is and anything else blocks. */
  async mkdir(path: string, mode: number): Promise<"made" | "existing" | "blocked"> {
    const parent = this.directory(parentOf(path));
    let created: PinnedDirectory;
    let existing = false;
    try {
      created = parent.mkdir(nameOf(path));
    } catch (error) {
      if (!this.merging || code(error) !== "EEXIST") throw error;
      try {
        created = parent.child(nameOf(path));
        existing = true;
      } catch {
        return "blocked";
      }
    }
    try {
      const info = created.stat();
      if (!existing) await chmodFd(created.fd, mode);
      this.made.set(path, { dev: info.dev, ino: info.ino });
    } finally {
      created.closeSync();
    }
    return existing ? "existing" : "made";
  }
  release(): void {
    this.open?.directory.closeSync();
    this.open = undefined;
  }
}

/** Writes one file; `false` when merging and that name is already taken. */
async function writeFile(
  tree: Tree,
  path: string,
  header: Header,
  stream: EntryStream,
  options: { signal?: AbortSignal | undefined; merging: boolean },
): Promise<boolean> {
  const { signal } = options;
  let fd: number;
  try {
    fd = tree.directory(parentOf(path)).createExclusive(nameOf(path));
  } catch (error) {
    if (options.merging && code(error) === "EEXIST") return false;
    throw error;
  }
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
  return true;
}

/** Whether a folder-relative directory of the destination is a link already there. */
async function linkThere(destination: string, path: string): Promise<boolean> {
  try {
    return (await lstat(join(destination, path))).isSymbolicLink();
  } catch {
    return false;
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
  const { entries } = await extractArchive(file, destination, { ...options, merging: false });
  return { entries };
}

export interface MergeResult {
  /** Members written. */
  entries: number;
  /** Regular files written. */
  files: number;
  /** Members left out because that name was already taken there, or sat under a non-folder. */
  skipped: number;
}

/**
 * Adds a folder archive's members to `destination`, an existing directory, never replacing
 * anything: a file or link whose name is taken is skipped, an existing folder is used as it is,
 * and a member whose parent there is not a folder is skipped. The same rules as unpackArchive
 * keep every write inside the destination.
 */
export async function mergeArchive(
  file: string,
  destination: string,
  options: {
    signal?: AbortSignal;
    /** Members (and, for a folder, everything under it) never written, counted as skipped. */
    exclude?: (path: string) => boolean;
  } = {},
): Promise<MergeResult> {
  return extractArchive(file, destination, { ...options, merging: true });
}

async function extractArchive(
  file: string,
  destination: string,
  options: { signal?: AbortSignal; merging: boolean; exclude?: (path: string) => boolean },
): Promise<MergeResult> {
  const { signal, merging, exclude } = options;
  checkAborted(signal);
  const root = PinnedDirectory.atBoundary(destination);
  const tree = new Tree(root, merging);
  const seen = new Set<string>();
  const links = new Map<string, string>();
  const blocked = new Set<string>();
  let entries = 0;
  let files = 0;
  let skipped = 0;
  try {
    if (!root.stat().isDirectory())
      throw new FolderArchiveError("NOT_EMPTY", "Destination must be a directory");
    if (!merging && !root.empty())
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
      if (exclude?.(path)) {
        if (type === "directory") blocked.add(path);
        skipped++;
        return;
      }
      for (let above = parent; above; above = parentOf(above))
        if (blocked.has(above)) {
          if (type === "directory") blocked.add(path);
          skipped++;
          return;
        }
      if (!tree.has(parent)) throw unsafe("Archive entry has no parent directory", path);
      if (type !== "file" && (header.size ?? 0) !== 0)
        throw unsafe("Archive entry carries unexpected data", path);
      if (type === "file") {
        if (!(await writeFile(tree, path, header, stream, { signal, merging }))) {
          skipped++;
          return;
        }
        files++;
      } else if (type === "directory") {
        const made = await tree.mkdir(path, ((header.mode ?? 0o755) & 0o755) | 0o700);
        if (made === "blocked") {
          blocked.add(path);
          skipped++;
          return;
        }
        if (made === "existing") return;
      } else if (type === "symlink") {
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
      if (merging) {
        // A link must not route through a link the destination already had.
        const route = linkRoute(path, target) ?? [];
        let through = false;
        for (const directory of route) if (await linkThere(destination, directory)) through = true;
        if (through) {
          skipped++;
          continue;
        }
      }
      try {
        tree.directory(parentOf(path)).symlink(target, nameOf(path));
      } catch (error) {
        if (!merging || code(error) !== "EEXIST") throw error;
        skipped++;
        entries--;
      }
    }
    return { entries, files, skipped };
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
