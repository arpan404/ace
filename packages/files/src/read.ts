import { promisify } from "node:util";
import { gzip as gzipCallback } from "node:zlib";
import { isWorkspaceTransferTemporary } from "@ace/workspace";
import type { FileOperation, FileReadResult } from "@ace/protocol";
import type { FilesIo } from "./io.ts";
import { FileError } from "./types.ts";

const gzip = promisify(gzipCallback);
/** Smaller parts aren't worth compressing: the saving is less than a frame's overhead. */
const compressFrom = 2048;

type Read = Extract<FileOperation, { op: "read" }>;

/**
 * One part of a file with its details: what a viewer needs from a single round trip.
 *
 * The bytes come from the workspace's port with the version they were read at, so a file that
 * changes while being read fails with CONFLICT, as a download does. The part's size is the whole
 * file's, which is how a viewer knows to ask for the next one.
 */
export async function readPart(
  io: FilesIo,
  root: string,
  operation: Read,
): Promise<FileReadResult> {
  const { path } = operation;
  if (isWorkspaceTransferTemporary(path))
    throw new FileError("INVALID_PATH", "Upload temporary files are private");
  const meta = await io.metadata(root, path);
  if (meta === null) return { path, version: null };
  // A folder's version walks its whole tree; a viewer only needs to know it's a folder.
  if (meta.kind === "directory") return { path, version: "directory", type: meta.kind };
  const read = await io.read(root, path, {
    offset: operation.offset,
    length: operation.length,
    ...(operation.maxSize === undefined ? {} : { maxSize: operation.maxSize }),
  });
  if (operation.validator !== undefined && operation.validator !== read.version)
    throw new FileError("CONFLICT", "File version changed", read.version);
  if (operation.maxSize !== undefined && read.size > operation.maxSize)
    return { path, version: read.version, type: meta.kind, size: read.size };
  const packed =
    operation.encodings.includes("gzip") && read.bytes.length >= compressFrom
      ? await gzip(read.bytes, { level: 6 })
      : undefined;
  const compressed = packed !== undefined && packed.length < read.bytes.length;
  return {
    path,
    version: read.version,
    type: meta.kind,
    size: read.size,
    offset: operation.offset,
    encoding: compressed ? "gzip" : "identity",
    data: (compressed ? packed : read.bytes).toString("base64"),
  };
}
