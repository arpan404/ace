import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { createGzip } from "node:zlib";
import { GitIgnore, SafeRoot, walkWorkspace } from "@ace/workspace";
import { z } from "zod";
import { openDownload } from "./download.ts";
import { FileError, version, type Download } from "./types.ts";

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
}
function stringField(header: Buffer, value: string, offset: number, size: number): void {
  if (Buffer.byteLength(value) > size)
    throw new FileError("LIMIT_EXCEEDED", "Path exceeds ustar limits");
  header.write(value, offset, size, "utf8");
}
function numberField(header: Buffer, value: number, offset: number, size: number): void {
  const octal = Math.floor(value).toString(8);
  if (octal.length >= size) throw new FileError("LIMIT_EXCEEDED", "File exceeds ustar size limit");
  header.write(octal.padStart(size - 1, "0") + "\0", offset, size, "ascii");
}
function tarHeader(entry: Entry): Buffer {
  const result = Buffer.alloc(512);
  let name = entry.name;
  if (Buffer.byteLength(name) > 100) {
    let split = name.lastIndexOf("/");
    while (split >= 0 && Buffer.byteLength(name.slice(split + 1)) > 100)
      split = name.lastIndexOf("/", split - 1);
    if (split < 0) throw new FileError("LIMIT_EXCEEDED", "Path exceeds ustar limits");
    stringField(result, name.slice(0, split), 345, 155);
    name = name.slice(split + 1);
  }
  stringField(result, name, 0, 100);
  numberField(result, entry.directory ? 0o755 : 0o644, 100, 8);
  numberField(result, 0, 108, 8);
  numberField(result, 0, 116, 8);
  numberField(result, entry.directory ? 0 : entry.size, 124, 12);
  numberField(result, entry.mtime / 1000, 136, 12);
  result.fill(32, 148, 156);
  result[156] = entry.directory ? 53 : 48;
  result.write("ustar\0", 257, "ascii");
  result.write("00", 263, "ascii");
  let checksum = 0;
  for (const byte of result) checksum += byte;
  result.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  return result;
}
export async function previewArchive(
  safe: SafeRoot,
  path: string,
  includeIgnored: boolean,
  id: string,
  expires: number,
): Promise<Preview> {
  const base = safe.path(path);
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
    tarHeader(item); // Validate names and sizes before announcing a stream.
    metadataBytes += Buffer.byteLength(item.path) + Buffer.byteLength(item.name) + 256;
    if (entries.length >= 100_000 || metadataBytes > 16 * 1024 * 1024)
      throw new FileError("LIMIT_EXCEEDED", "Archive metadata exceeds preview budget");
    entries.push(item);
    bytes += item.directory ? 0 : item.size;
    digest.update(item.path);
    digest.update(item.version);
  }
  return { id, expires, bytes, entries, validator: digest.digest("hex") };
}
export function archiveDownload(safe: SafeRoot, preview: Preview): Download {
  let current: Download | undefined;
  const gzip = createGzip({ chunkSize: 64 * 1024 });
  async function* tar(): AsyncGenerator<Buffer> {
    try {
      for (const entry of preview.entries) {
        if (version((await safe.metadata(entry.path)).info) !== entry.version)
          throw new FileError("CONFLICT", "Archive entry changed");
        yield tarHeader(entry);
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
  gzip.on("close", () => source.destroy());
  source.pipe(gzip);
  async function* chunks(): AsyncGenerator<Buffer> {
    try {
      for await (const chunk of gzip) {
        const bytes = z.instanceof(Buffer).parse(chunk);
        yield bytes;
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
