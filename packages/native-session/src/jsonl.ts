import { safeOpen, fingerprint } from "./files.ts";

export type NativeRecord =
  | { value: unknown; offset: number; bytes: number }
  | { oversized: true; offset: number; bytes: number }
  | { malformed: true; offset: number; bytes: number };
export const RECORD_LIMIT = 1024 * 1024;
/** No readline: one provider line itself can be gigabytes. Keep at most 1 MiB. */
export async function* readJsonLines(
  home: string,
  path: string,
  signal?: AbortSignal,
): AsyncGenerator<NativeRecord> {
  const file = await safeOpen(home, path);
  try {
    const before = await file.stat();
    const buffer = Buffer.alloc(64 * 1024);
    let position = 0;
    let start = 0;
    let length = 0;
    let chunks: Buffer[] = [];
    const record = (): NativeRecord => {
      if (length > RECORD_LIMIT) return { oversized: true, offset: start, bytes: length };
      try {
        return {
          value: JSON.parse(Buffer.concat(chunks, length).toString("utf8")),
          offset: start,
          bytes: length,
        };
      } catch {
        return { malformed: true, offset: start, bytes: length };
      }
    };
    while (position < before.size) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(
        buffer,
        0,
        Math.min(buffer.length, before.size - position),
        position,
      );
      if (!bytesRead) throw new Error("Session shrank during import");
      let cursor = 0;
      while (cursor < bytesRead) {
        const newline = buffer.indexOf(10, cursor);
        const end = newline < 0 || newline >= bytesRead ? bytesRead : newline;
        length += end - cursor;
        if (length <= RECORD_LIMIT) chunks.push(Buffer.from(buffer.subarray(cursor, end)));
        else chunks = [];
        if (end < bytesRead) {
          if (length) yield record();
          start = position + end + 1;
          length = 0;
          chunks = [];
        }
        cursor = end + 1;
      }
      position += bytesRead;
    }
    // A valid final JSON record without newline is accepted. A live fragment is retained as malformed raw.
    if (length) yield record();
    if (fingerprint(before) !== fingerprint(await file.stat()))
      throw new Error("Session changed during import");
  } finally {
    await file.close();
  }
}
export async function* readRange(
  home: string,
  path: string,
  offset: number,
  bytes: number,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const file = await safeOpen(home, path);
  try {
    for (let read = 0; read < bytes;) {
      signal?.throwIfAborted();
      const buffer = Buffer.alloc(Math.min(64 * 1024, bytes - read));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset + read);
      if (!bytesRead) throw new Error("Source range disappeared");
      read += bytesRead;
      yield buffer.subarray(0, bytesRead);
    }
  } finally {
    await file.close();
  }
}
