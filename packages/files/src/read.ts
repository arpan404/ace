import { promisify } from "node:util";
import { gzip as gzipCallback } from "node:zlib";
import { SafeRoot, isWorkspaceTransferTemporary } from "@ace/workspace";
import type { FileOperation, FileReadResult } from "@ace/protocol";
import { observed } from "./filesystem.ts";
import { codeOf, FileError, version } from "./types.ts";

const gzip = promisify(gzipCallback);
/** Smaller parts aren't worth compressing: the saving is less than a frame's overhead. */
const compressFrom = 2048;

type Read = Extract<FileOperation, { op: "read" }>;

/**
 * One part of a file with its details: what a viewer needs from a single round trip. Bytes are
 * read through the confined handle and checked against the version they're labelled with; a file
 * that changes while being read fails with CONFLICT, as a download does.
 */
export async function readPart(safe: SafeRoot, operation: Read): Promise<FileReadResult> {
  const { path } = operation;
  if (isWorkspaceTransferTemporary(safe.path(path)))
    throw new FileError("INVALID_PATH", "Upload temporary files are private");
  let type: FileReadResult["type"];
  try {
    type = (await safe.metadata(path)).type;
  } catch (error) {
    if (codeOf(error) === "NOT_FOUND") return { path, version: null };
    throw error;
  }
  // A folder's version walks its whole tree; a viewer only needs to know it's a folder.
  if (type === "directory") return { path, version: "directory", type };
  const current = await observed(safe, path);
  if (current === null) return { path, version: null };
  if (operation.validator !== undefined && operation.validator !== current)
    throw new FileError("CONFLICT", "File version changed", current);
  const { handle, info, resolved } = await safe.file(path);
  try {
    const size = info.size;
    if (operation.maxSize !== undefined && size > operation.maxSize)
      return { path, version: current, type, size };
    if (operation.offset > size)
      throw new FileError("CONFLICT", "Offset is past the end of the file", current);
    const length = Math.min(operation.length, size - operation.offset);
    const bytes = Buffer.allocUnsafe(length);
    let done = 0;
    while (done < length) {
      const read = await handle.read(bytes, done, length - done, operation.offset + done);
      if (!read.bytesRead) throw new FileError("CONFLICT", "File was truncated while reading");
      done += read.bytesRead;
    }
    if (version(await handle.stat()) !== version(info))
      throw new FileError("CONFLICT", "File changed while reading");
    await safe.verify(path, resolved, info);
    const packed =
      operation.encodings.includes("gzip") && length >= compressFrom
        ? await gzip(bytes, { level: 6 })
        : undefined;
    const compressed = packed !== undefined && packed.length < length;
    return {
      path,
      version: current,
      type,
      size,
      offset: operation.offset,
      encoding: compressed ? "gzip" : "identity",
      data: (compressed ? packed : bytes).toString("base64"),
    };
  } finally {
    await handle.close();
  }
}
