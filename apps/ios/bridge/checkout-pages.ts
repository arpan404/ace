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
 * A page's text keeps every byte it can: a leading byte order mark stays (a default decoder
 * drops it, and a part saved from that text would lose those 3 bytes).
 */
const pageText = new TextDecoder("utf-8", { ignoreBOM: true });

/**
 * Where a page of `bytes` should end: after its last line break, or (one line longer than a
 * page) before its last grapheme cluster, which may go on past the part (an "e" whose
 * combining accent is in the next part), so no page ends inside a character as a person sees
 * it, and find matches it whole. The whole part when it reaches the file's end.
 */
export function pageEnd(bytes: Uint8Array, atEnd: boolean): number {
  if (atEnd || bytes.length === 0) return bytes.length;
  const lastBreak = bytes.lastIndexOf(newline);
  if (lastBreak >= 0) return lastBreak + 1;
  let end = bytes.length;
  // Step back over continuation bytes to the start of the last character, then before it.
  while (end > 0 && ((bytes[end - 1] ?? 0) & 0xc0) === 0x80) end--;
  end = end > 0 && (bytes[end - 1] ?? 0) >= 0xc0 ? end - 1 : bytes.length;
  // Then before the last whole cluster, judged from the bytes just before the cut.
  let start = Math.max(0, end - clusterWindow);
  while (start < end && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++;
  const tail = new TextDecoder().decode(bytes.subarray(start, end));
  const clusters = [...graphemes.segment(tail)];
  const last = clusters.at(-1);
  if (clusters.length < 2 || !last) return end;
  return end - utf8.encode(last.segment).length;
}

/** How far back a page's last cluster is looked for; a longer cluster is cut at a character. */
const clusterWindow = 1024;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const utf8 = new TextEncoder();

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
  // A first part cut inside a character is still text: only the bytes it holds are judged.
  if (input.offset === 0 && !isText(read.bytes, !atEnd))
    throw new CheckoutError("binary", "This file isn't text, so it can't be read in pages.");
  const end = pageEnd(read.bytes, atEnd);
  return {
    text: pageText.decode(read.bytes.subarray(0, end)),
    offset: input.offset,
    nextOffset: input.offset + end,
    size,
    version: read.version,
    done: input.offset + end >= size,
  };
}
