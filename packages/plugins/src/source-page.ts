import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { assertNoSymlinks } from "./files.ts";
import { limits } from "./manifest.ts";
import type { PackageFile } from "./types.ts";

/** Pure paging over an encoded slice, including the byte after the requested page. */
export function sourcePage(bytes: Buffer, total: number, offset: number, limit: number) {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > total ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 65536 ||
    (offset < total && ((bytes[0] ?? 0) & 0xc0) === 0x80)
  )
    throw new Error("Source unavailable");
  let end = Math.min(total - offset, Math.max(4, limit));
  while (offset + end < total && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end));
  if (offset < total && end === 0) throw new Error("Source unavailable");
  return { bytes: total, offset, nextOffset: offset + end, text };
}

/** Verify the opened descriptor, streaming the accepted hash while retaining only one page.
 * Nonblocking open plus fstat prevents replacement FIFOs from retaining daemon requests.
 */
export async function readSourcePage(
  path: string,
  file: PackageFile,
  offset: number,
  limit: number,
) {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > file.bytes ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 65536 ||
    file.bytes > limits.file
  )
    throw new Error("Source unavailable");
  await assertNoSymlinks(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("Special file forbidden");
    if (info.size !== file.bytes) throw new Error("Integrity mismatch");
    const hash = createHash("sha256");
    const page = Buffer.alloc(Math.min(file.bytes - offset, Math.max(4, limit) + 1));
    const chunk = Buffer.alloc(Math.min(65536, file.bytes + 1));
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(
        chunk,
        0,
        Math.min(chunk.length, file.bytes - position + 1),
        position,
      );
      if (bytesRead === 0) break;
      if (position + bytesRead > file.bytes) throw new Error("Integrity mismatch");
      hash.update(chunk.subarray(0, bytesRead));
      const start = Math.max(position, offset),
        end = Math.min(position + bytesRead, offset + page.length);
      if (end > start) chunk.copy(page, start - offset, start - position, end - position);
      position += bytesRead;
    }
    if (
      position !== file.bytes ||
      hash.digest("hex") !== file.hash ||
      (await handle.stat()).size !== file.bytes
    )
      throw new Error("Integrity mismatch");
    return sourcePage(page, file.bytes, offset, limit);
  } finally {
    await handle.close();
  }
}
