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
// JSON escaping is part of the transport budget: controls can expand sixfold.
function characterBytes(byte: number): number {
  return byte < 0x80 ? 1 : byte < 0xe0 ? 2 : byte < 0xf0 ? 3 : 4;
}
function serializedBytes(byte: number): number {
  if (byte === 34 || byte === 92) return 2;
  if (byte < 32) return [8, 9, 10, 12, 13].includes(byte) ? 2 : 6;
  return characterBytes(byte);
}
function outputTail(text: string): string {
  const bytes = encoder.encode(utf8Slice(text, 4096, true));
  let start = bytes.length;
  let size = 0;
  while (start > 0) {
    let next = start - 1;
    while (((bytes[next] ?? 0) & 0xc0) === 0x80) next--;
    const cost = serializedBytes(bytes[next] ?? 0);
    if (size + cost > 4096) break;
    size += cost;
    start = next;
  }
  return decoder.decode(bytes.subarray(start));
}
/** Split output at whole characters, budgeting both UTF-8 and JSON bytes. */
export function* outputDeltas(text: string): Generator<string> {
  const bytes = encoder.encode(text);
  if (!bytes.length) {
    yield "";
    return;
  }
  let start = 0;
  let size = 0;
  for (let end = 0; end < bytes.length;) {
    const byte = bytes[end] ?? 0;
    const cost = serializedBytes(byte);
    if (size + cost > 4096) {
      yield decoder.decode(bytes.subarray(start, end));
      start = end;
      size = 0;
    }
    size += cost;
    end += characterBytes(byte);
  }
  yield decoder.decode(bytes.subarray(start));
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
  const tail = outputTail(
    addedBytes >= 4096 ? append : (previous?.tail ?? "") + utf8Slice(append, 4096, true),
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
