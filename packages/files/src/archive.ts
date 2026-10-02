import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { createGzip } from "node:zlib";
import { GitIgnore, SafeRoot, walkWorkspace } from "@ace/workspace";
import { z } from "zod";
import { tarHeaders } from "./tar.ts";
import { openDownload } from "./download.ts";
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
    // Reserved in-progress upload files never belong in an archive.
    if (entry.path.split("/").some((part) => part.startsWith(".ace-upload-"))) continue;
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
  const gzip = createGzip({ chunkSize: 64 * 1024 });
  async function* tar(): AsyncGenerator<Buffer> {
    try {
      if (version((await safe.metadata(preview.path)).info) !== preview.rootVersion)
        throw new FileError("CONFLICT", "Directory changed since preview");
      for (const entry of preview.entries) {
        if (version((await safe.metadata(entry.path)).info) !== entry.version)
          throw new FileError("CONFLICT", "Archive entry changed");
        yield* tarHeaders(entry);
        if (!entry.directory) {
          current = await openDownload(safe, entry.path, 0, entry.version);
          yield* current.chunks;
          current = undefined;
          const padding = (512 - (entry.size % 512)) % 512;
          if (padding) yield Buffer.alloc(padding);
        }
      }
      yield Buffer.alloc(1024);
    } finally {
      await current?.close();
    }
  }
  const source = Readable.from(tar(), { objectMode: false, highWaterMark: 64 * 1024 });
  source.on("error", (error) => gzip.destroy(error));
  gzip.on("error", () => {}); // Preserve the stream error for the next credited iterator read.
  gzip.on("close", () => source.destroy());
  source.pipe(gzip);
  async function* chunks(): AsyncGenerator<Buffer> {
    try {
      for await (const chunk of gzip) {
        const bytes = z.instanceof(Buffer).parse(chunk);
        for (let start = 0; start < bytes.length; start += CHUNK_SIZE)
          yield bytes.subarray(start, start + CHUNK_SIZE);
      }
    } finally {
      source.destroy();
      gzip.destroy();
      await current?.close();
    }
  }
  return {
    size: null,
    offset: 0,
    validator: preview.validator,
    chunks: chunks(),
    async close() {
      source.destroy();
      gzip.destroy();
      await current?.close();
    },
  };
}
