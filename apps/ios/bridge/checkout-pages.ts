import { readFileRange, type FileReader } from "@ace/client";
import { checkoutError, CheckoutError, isCheckoutPath, isText, fromCode } from "@ace/ui-core";
import type { FilesScope } from "./checkout-request.ts";

/*
 * A file too large to show whole, read a page at a time: each page is the next part the daemon
 * returns (at most 256 KiB), cut back to its last line break so no line or character is split,
 * and pinned to the version the first page was read at.
 */

const newline = 0x0a;

/**
 * Where a page of `bytes` should end: after its last line break, or (one line longer than a
 * page) after its last whole UTF-8 character. The whole part when it reaches the file's end.
 */
export function pageEnd(bytes: Uint8Array, atEnd: boolean): number {
  if (atEnd || bytes.length === 0) return bytes.length;
  const lastBreak = bytes.lastIndexOf(newline);
  if (lastBreak >= 0) return lastBreak + 1;
  let end = bytes.length;
  // Step back over continuation bytes to the start of the last character, then before it.
  while (end > 0 && ((bytes[end - 1] ?? 0) & 0xc0) === 0x80) end--;
  return end > 0 && (bytes[end - 1] ?? 0) >= 0xc0 ? end - 1 : bytes.length;
}

export async function readPage(
  owner: FileReader,
  scope: FilesScope,
  input: { path: string; offset: number; version?: string | undefined },
  signal: AbortSignal,
) {
  if (!isCheckoutPath(input.path)) throw fromCode("OUTSIDE_WORKSPACE");
  const read = await readFileRange(
    owner,
    { ...scope, path: input.path, offset: input.offset, validator: input.version },
    { signal, timeoutMs: 30_000 },
  ).catch((error: unknown) => {
    const parsed = checkoutError(error);
    if (parsed.code === "CONFLICT")
      throw new CheckoutError("changed", "The file changed while you read it. Open it again.");
    throw parsed;
  });
  if (read.kind !== "file") throw new CheckoutError("missing", "Nothing is at this path any more.");
  const size = read.size ?? 0;
  const atEnd = input.offset + read.bytes.length >= size;
  if (input.offset === 0 && !isText(read.bytes))
    throw new CheckoutError("binary", "This file isn't text, so it can't be read in pages.");
  const end = pageEnd(read.bytes, atEnd);
  return {
    text: new TextDecoder().decode(read.bytes.subarray(0, end)),
    offset: input.offset,
    nextOffset: input.offset + end,
    size,
    version: read.version,
    done: input.offset + end >= size,
  };
}
