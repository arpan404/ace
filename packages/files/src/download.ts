import { isWorkspaceTransferTemporary } from "@ace/workspace";
import type { FilesIo } from "./io.ts";
import { CHUNK_SIZE, FileError, type Download } from "./types.ts";

/**
 * Open a file's bytes for a channel, one chunk at a time.
 *
 * The first byte is read at open, so a file the daemon may not open, a folder and a missing path
 * all fail the request itself rather than the channel that follows, exactly as opening the file
 * did before. The whole file is never held: each chunk is read from the workspace's port at its
 * offset, every range is checked against the version and size the download started with, and the
 * read itself refuses a file that changes underneath it, so a resumed download never splices two
 * versions together. An `offset` past 0 needs the validator it resumes.
 */
export async function openDownload(
  io: FilesIo,
  root: string,
  path: string,
  offset: number,
  validator?: string,
): Promise<Download> {
  if (isWorkspaceTransferTemporary(path))
    throw new FileError("INVALID_PATH", "Upload temporary files are private");
  const opened = await io.read(root, path, { offset: 0, length: 1 });
  const current = opened.version;
  const size = opened.size;
  if (
    offset > size ||
    (validator !== undefined && validator !== current) ||
    (offset > 0 && validator === undefined)
  )
    throw new FileError("CONFLICT", "Resume requires the unchanged file validator", current);
  async function* chunks(): AsyncGenerator<Buffer> {
    let position = offset;
    while (position < size) {
      const read = await io.read(root, path, {
        offset: position,
        length: Math.min(CHUNK_SIZE, size - position),
      });
      // The range carries the version and size it was read at. Anything else is a replacement:
      // its bytes are never yielded, so a download and an archive never splice two files.
      const changed = read.version !== current || read.size !== size;
      if (changed) throw new FileError("CONFLICT", "File changed while reading", read.version);
      if (!read.bytes.length) throw new FileError("CONFLICT", "File was truncated while reading");
      position += read.bytes.length;
      yield read.bytes;
    }
    const after = await io.describe(root, path);
    if (after === null || after.version !== current)
      throw new FileError("CONFLICT", "File changed while reading", after?.version ?? null);
  }
  return { size, offset, validator: current, chunks: chunks(), close: async () => {} };
}
