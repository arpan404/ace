import { isUtf8 } from "node:buffer";
import type { SafeRoot } from "./safety.ts";
import { failure, integer, READ_CAP, type ReadOptions, type ReadResult } from "./types.ts";

export async function read(safe: SafeRoot, options: ReadOptions): Promise<ReadResult> {
  const path = safe.path(options.path);
  const offset = integer(options.offset ?? 0, "offset", 0, Number.MAX_SAFE_INTEGER);
  const length = integer(options.length ?? READ_CAP, "length", 0, Number.MAX_SAFE_INTEGER);
  const { handle, info } = await safe.file(path);
  try {
    const probe = Buffer.alloc(Math.min(info.size, 8192));
    const head = await handle.read(probe, 0, probe.length, 0);
    const meta = { path, size: info.size, mtime: info.mtimeMs, offset };
    if (probe.subarray(0, head.bytesRead).includes(0)) {
      return { ...meta, binary: true, bytesRead: 0, truncated: false };
    }
    const bytes = Buffer.alloc(Math.min(length, READ_CAP, Math.max(0, info.size - offset)));
    let count = 0;
    while (count < bytes.length) {
      const chunk = await handle.read(bytes, count, bytes.length - count, offset + count);
      if (!chunk.bytesRead) break;
      count += chunk.bytesRead;
    }
    const data = bytes.subarray(0, count);
    return {
      ...meta,
      binary: false,
      text: data.toString("utf8"),
      bytesRead: count,
      encoding: isUtf8(data) ? "utf-8" : "utf-8-lossy",
      truncated: offset + count < info.size,
    };
  } catch (error) {
    throw failure(error);
  } finally {
    await handle.close();
  }
}
