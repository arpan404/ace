import { SafeRoot, isWorkspaceTransferTemporary } from "@ace/workspace";
import { CHUNK_SIZE, FileError, version, type Download } from "./types.ts";

export function openDownload(
  safe: SafeRoot,
  path: string,
  offset: number,
  validator?: string,
): Promise<Download> {
  return openFile(safe, path, offset, (length) => Buffer.allocUnsafe(length), validator);
}
/** Input bytes remain valid until the consumer requests the next chunk. */
export function openBorrowedDownload(
  safe: SafeRoot,
  path: string,
  offset: number,
  validator?: string,
): Promise<Download> {
  const buffer = Buffer.allocUnsafe(CHUNK_SIZE);
  return openFile(safe, path, offset, (length) => buffer.subarray(0, length), validator);
}
async function openFile(
  safe: SafeRoot,
  path: string,
  offset: number,
  allocate: (length: number) => Buffer,
  validator?: string,
): Promise<Download> {
  if (isWorkspaceTransferTemporary(safe.path(path)))
    throw new FileError("INVALID_PATH", "Upload temporary files are private");
  const { handle, info } = await safe.file(path);
  let closed = false;
  const close = async () => {
    if (!closed) {
      closed = true;
      await handle.close();
    }
  };
  try {
    const current = version(info);
    if (
      offset > info.size ||
      (validator !== undefined && validator !== current) ||
      (offset > 0 && validator === undefined)
    )
      throw new FileError("CONFLICT", "Resume requires the unchanged file validator", current);
    const resolved = await safe.resolve(path);
    async function* chunks(): AsyncGenerator<Buffer> {
      let position = offset;
      try {
        while (position < info.size) {
          const bytes = allocate(Math.min(CHUNK_SIZE, info.size - position));
          const read = await handle.read(bytes, 0, bytes.length, position);
          if (!read.bytesRead) throw new FileError("CONFLICT", "File was truncated while reading");
          position += read.bytesRead;
          yield bytes.subarray(0, read.bytesRead);
        }
        if (version(await handle.stat()) !== current)
          throw new FileError("CONFLICT", "File changed while reading");
        await safe.verify(path, resolved, info);
      } finally {
        await close();
      }
    }
    return { size: info.size, offset, validator: current, chunks: chunks(), close };
  } catch (error) {
    await close();
    throw error;
  }
}
