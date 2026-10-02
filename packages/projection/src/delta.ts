import type { Item, OutputSummary } from "@ace/protocol";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
/** Return whole UTF-8 characters within the byte budget. */
export function utf8Slice(text: string, limit: number, tail = false): string {
  const bytes = encoder.encode(text);
  if (bytes.length <= limit) return decoder.decode(bytes);
  let start = tail ? bytes.length - limit : 0;
  let end = tail ? bytes.length : limit;
  if (tail) while (((bytes[start] ?? 0) & 0xc0) === 0x80) start++;
  else while (((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return decoder.decode(bytes.subarray(start, end));
}
/** Split output facts into bounded canonical deltas at UTF-8 character boundaries. */
export function* outputDeltas(text: string): Generator<string> {
  const bytes = encoder.encode(text);
  if (!bytes.length) {
    yield "";
    return;
  }
  for (let start = 0; start < bytes.length;) {
    let end = Math.min(start + 4096, bytes.length);
    while (end < bytes.length && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
    yield decoder.decode(bytes.subarray(start, end));
    start = end;
  }
}
export function outputStreamId(itemId: string): string {
  return `output:${itemId}`;
}
export function summarizeOutput(
  itemId: string,
  append: string,
  previous?: OutputSummary,
): OutputSummary {
  const addedBytes = encoder.encode(append).length;
  const bytes = (previous?.bytes ?? 0) + addedBytes;
  const tail = utf8Slice(
    addedBytes >= 4096 ? append : (previous?.tail ?? "") + utf8Slice(append, 4096, true),
    4096,
    true,
  );
  return {
    streamId: previous?.streamId ?? outputStreamId(itemId),
    bytes,
    tail,
    truncated: bytes > encoder.encode(tail).length,
  };
}
/** Text and reasoning both append to reasoning/notice; messages accept only text.
 * Shell output retains a byte count and the last 4 KiB, never the full stream.
 * Returns false for a field that does not belong to the item, without mutation. */
export function applyDelta(
  item: Item,
  field: "text" | "reasoning" | "output",
  append: string,
): boolean {
  if (field === "output" && item.type === "tool_call" && item.call.detail.kind === "shell") {
    item.call.detail.output = summarizeOutput(item.id, append, item.call.detail.output);
  } else if (field !== "output" && (item.type === "reasoning" || item.type === "notice")) {
    item.text += append;
  } else if (field === "text" && item.type === "message") {
    const last = item.parts.at(-1);
    if (last?.type === "text") last.text += append;
    else item.parts.push({ type: "text", text: append });
  } else return false;
  return true;
}
