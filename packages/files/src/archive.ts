import { createHash } from "node:crypto";
import { createGzip } from "node:zlib";
import type { FilesIo, WalkEntry } from "./io.ts";
import { openDownload } from "./download.ts";
import { readChunks } from "./readable-chunks.ts";
import { tarHeaders } from "./tar.ts";
import { CHUNK_SIZE, FileError, type Download } from "./types.ts";

interface Entry {
  path: string;
  name: string;
  size: number;
  /** The entry's version when the preview was made; a download refuses anything else. */
  version: string;
  mtime: number;
  directory: boolean;
}
export interface Preview {
  id: string;
  expires: number;
  bytes: number;
  entries: Entry[];
  validator: string;
  /** Root-relative folder the preview was made of. */
  path: string;
  rootVersion: string;
}

/** How many entries a preview reads versions for at once. */
const VERSION_CONCURRENCY = 8;

/**
 * Every walked entry's own version, read a few at a time so a large folder's preview does not wait
 * for one round trip after another.
 */
async function versions(
  io: FilesIo,
  root: string,
  entries: WalkEntry[],
  signal?: AbortSignal,
): Promise<string[]> {
  const found = Array.from({ length: entries.length }, () => "");
  let next = 0;
  const work = async () => {
    while (next < entries.length) {
      const index = next++;
      const entry = entries[index];
      if (!entry) continue;
      const description = await io.shallow(root, entry.path, { signal });
      found[index] = description?.version ?? "";
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(VERSION_CONCURRENCY, entries.length) }, () => work()),
  );
  return found;
}

/**
 * One folder as a downloadable archive, described without reading any file's bytes.
 *
 * The walk comes from the checkout's port, which leaves out `.git` and the daemon's transfer
 * temporaries. The root's version is read before and after so an archive that would mix two
 * states of the folder is refused rather than produced.
 */
export async function previewArchive(
  io: FilesIo,
  root: string,
  path: string,
  includeIgnored: boolean,
  id: string,
  expires: number,
  signal?: AbortSignal,
): Promise<Preview> {
  const before = await io.describe(root, path, signal ? { signal } : {});
  if (before === null) throw new FileError("NOT_FOUND", "Folder not found");
  const walked: WalkEntry[] = [];
  let metadataBytes = 0;
  for await (const entry of io.walk(root, path, signal ? { signal } : {})) {
    if (entry.type !== "file" && entry.type !== "directory") continue;
    if (entry.ignored && !includeIgnored) continue;
    metadataBytes += Buffer.byteLength(entry.path) + 256;
    if (walked.length > 100_000 || metadataBytes > 16 * 1024 * 1024)
      throw new FileError("LIMIT_EXCEEDED", "Archive metadata exceeds preview budget");
    walked.push(entry);
  }
  const stamped = await versions(io, root, walked, signal);
  if (stamped.some((version) => version === ""))
    throw new FileError("CONFLICT", "Directory changed during preview");
  const entries: Entry[] = [];
  let bytes = 0;
  const digest = createHash("sha256");
  for (const [index, entry] of walked.entries()) {
    const item = {
      path: entry.path,
      name: path ? entry.path.slice(path.length + 1) : entry.path,
      size: entry.size,
      version: stamped[index] ?? "",
      mtime: entry.mtime,
      directory: entry.type === "directory",
    };
    entries.push(item);
    bytes += item.directory ? 0 : item.size;
    digest.update(item.path);
    digest.update(item.version);
  }
  const after = await io.describe(root, path, signal ? { signal } : {});
  if (after?.version !== before.version)
    throw new FileError("CONFLICT", "Directory changed during preview");
  return {
    id,
    expires,
    bytes,
    entries,
    validator: digest.digest("hex"),
    path,
    rootVersion: before.version,
  };
}

/**
 * The preview's bytes as a gzipped tar, streamed: each file is opened with the version the preview
 * recorded before its header is written, so a file that changed since the preview fails the
 * archive instead of being published under a stale name. Its bytes are read in chunks through the
 * port, never whole, and the folder's version is checked before anything is written.
 */
export function archiveDownload(io: FilesIo, root: string, preview: Preview): Download {
  let current: Download | undefined;
  let cancelled = false;
  const gzip = createGzip({ chunkSize: CHUNK_SIZE });
  // Keep errors observable before the first credit and during cancellation.
  gzip.on("error", () => {});
  const reader = readChunks(gzip);
  const write = (bytes: Buffer) =>
    new Promise<void>((resolve, reject) => {
      if (cancelled) {
        reject(new FileError("ABORTED", "Archive cancelled"));
        return;
      }
      gzip.write(bytes, (error) => (error ? reject(error) : resolve()));
    });
  const writing = (async () => {
    try {
      const now = await io.describe(root, preview.path);
      if (now?.version !== preview.rootVersion)
        throw new FileError("CONFLICT", "Directory changed since preview");
      for (const entry of preview.entries) {
        if (cancelled) break;
        if (!entry.directory) {
          // Open first: a changed file or a moved version is refused before its header lands.
          const opened = await openDownload(io, root, entry.path, 0, entry.version);
          if (opened.size !== entry.size) {
            await opened.close();
            throw new FileError("CONFLICT", "Archive entry changed", opened.validator);
          }
          current = opened;
        }
        for (const header of tarHeaders(entry)) await write(header);
        if (current) {
          // The gzip callback releases ownership before this buffer is refilled.
          for await (const bytes of current.chunks) await write(bytes);
          await current.close();
          current = undefined;
          const padding = (512 - (entry.size % 512)) % 512;
          if (padding) await write(Buffer.alloc(padding));
        }
      }
      if (!cancelled) {
        await write(Buffer.alloc(1024));
        gzip.end();
      }
    } finally {
      await current?.close();
    }
  })().catch((error: unknown) => {
    gzip.destroy(error instanceof Error ? error : new Error("Archive failed"));
  });
  const close = async () => {
    cancelled = true;
    gzip.destroy();
    await writing;
  };
  async function* chunks(): AsyncGenerator<Buffer> {
    try {
      for (;;) {
        const next = await reader.next();
        if (next.done) break;
        for (let start = 0; start < next.value.length; start += CHUNK_SIZE)
          yield next.value.subarray(start, start + CHUNK_SIZE);
      }
    } finally {
      await close();
      reader.dispose();
    }
  }
  return { size: null, offset: 0, validator: preview.validator, chunks: chunks(), close };
}
