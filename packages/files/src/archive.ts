import { createHash } from "node:crypto";
import { createGzip } from "node:zlib";
import { GitIgnore, SafeRoot, walkWorkspace } from "@ace/workspace";
import { readChunks } from "./readable-chunks.ts";
import { tarHeaders } from "./tar.ts";
import { openBorrowedDownload } from "./download.ts";
import { CHUNK_SIZE, FileError, version, type Download } from "./types.ts";

interface Entry {
  path: string;
  name: string;
  size: number;
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
  path: string;
  rootVersion: string;
}
export async function previewArchive(
  safe: SafeRoot,
  path: string,
  includeIgnored: boolean,
  id: string,
  expires: number,
): Promise<Preview> {
  const base = safe.path(path);
  const rootVersion = version((await safe.metadata(base)).info);
  const ignore = await GitIgnore.create(safe);
  const entries: Entry[] = [];
  let bytes = 0;
  let metadataBytes = 0;
  const digest = createHash("sha256");
  for await (const entry of walkWorkspace(safe, ignore, {
    dir: base,
    depth: Number.MAX_SAFE_INTEGER,
    includeIgnored,
  })) {
    if (entry.type !== "file" && entry.type !== "directory") continue;
    const { info } = await safe.metadata(entry.path);
    const item = {
      path: entry.path,
      name: base ? entry.path.slice(base.length + 1) : entry.path,
      size: info.size,
      version: version(info),
      mtime: info.mtimeMs,
      directory: entry.type === "directory",
    };
    metadataBytes += Buffer.byteLength(item.path) + Buffer.byteLength(item.name) + 256;
    if (entries.length >= 100_000 || metadataBytes > 16 * 1024 * 1024)
      throw new FileError("LIMIT_EXCEEDED", "Archive metadata exceeds preview budget");
    entries.push(item);
    bytes += item.directory ? 0 : item.size;
    digest.update(item.path);
    digest.update(item.version);
  }
  if (version((await safe.metadata(base)).info) !== rootVersion)
    throw new FileError("CONFLICT", "Directory changed during preview");
  return { id, expires, bytes, entries, validator: digest.digest("hex"), path: base, rootVersion };
}
export function archiveDownload(safe: SafeRoot, preview: Preview): Download {
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
      if (version((await safe.metadata(preview.path)).info) !== preview.rootVersion)
        throw new FileError("CONFLICT", "Directory changed since preview");
      for (const entry of preview.entries) {
        if (cancelled) break;
        if (version((await safe.metadata(entry.path)).info) !== entry.version)
          throw new FileError("CONFLICT", "Archive entry changed");
        for (const header of tarHeaders(entry)) await write(header);
        if (!entry.directory) {
          current = await openBorrowedDownload(safe, entry.path, entry.version);
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
