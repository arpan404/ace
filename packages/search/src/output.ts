import { z } from "zod";
import type { OutputSummary, ThreadId } from "@ace/protocol";
import { FIELD_CAP, capText, GAP } from "./text.ts";

/** Caller-owned output storage; each request is at most 64 KiB. */
export type OutputReader = (
  threadId: ThreadId,
  streamId: string,
  offset: number,
  limit: number,
) => Uint8Array | undefined;

const Bytes = z.instanceof(Uint8Array).refine((value) => value.length <= FIELD_CAP * 8);
function decode(bytes: Uint8Array, tail: boolean): string {
  let start = 0;
  let end = bytes.length;
  if (tail) while (((bytes[start] ?? 0) & 0xc0) === 0x80) start++;
  else {
    let last = end - 1;
    while (last >= 0 && ((bytes[last] ?? 0) & 0xc0) === 0x80) last--;
    const first = bytes[last] ?? 0;
    const length = first < 0x80 ? 1 : first < 0xe0 ? 2 : first < 0xf0 ? 3 : 4;
    if (last + length > end) end = last;
  }
  return new TextDecoder().decode(bytes.subarray(start, end));
}
export function outputText(
  reader: OutputReader | undefined,
  threadId: ThreadId,
  summary: OutputSummary,
): string {
  if (!reader || !summary.bytes) return summary.tail;
  const read = (offset: number, limit: number): Uint8Array | undefined => {
    const bytes = reader(threadId, summary.streamId, offset, limit);
    return bytes === undefined ? undefined : Bytes.parse(bytes);
  };
  if (summary.bytes <= FIELD_CAP * 8) {
    const bytes = read(0, summary.bytes);
    return bytes === undefined ? summary.tail : capText(decode(bytes, false));
  }
  const head = read(0, FIELD_CAP * 4);
  const tail = read(summary.bytes - FIELD_CAP * 4, FIELD_CAP * 4);
  if (!head || !tail) return summary.tail;
  return decode(head, false).slice(0, FIELD_CAP) + GAP + decode(tail, true).slice(-FIELD_CAP);
}
