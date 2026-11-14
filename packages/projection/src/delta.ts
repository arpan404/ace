import type { Item, OutputSummary, TextSource } from "@ace/protocol";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
/** Decode a byte suffix, dropping only an incomplete leading UTF-8 character. */
export function utf8Tail(bytes: Uint8Array, limit: number): string {
  let start = Math.max(0, bytes.length - limit);
  while (((bytes[start] ?? 0) & 0xc0) === 0x80) start++;
  return decoder.decode(bytes.subarray(start));
}
/** Return whole UTF-8 characters within the byte budget. */
export function utf8Slice(text: string, limit: number, tail = false): string {
  const bytes = encoder.encode(text);
  if (tail) return utf8Tail(bytes, limit);
  if (bytes.length <= limit) return decoder.decode(bytes);
  let end = limit;
  while (((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return decoder.decode(bytes.subarray(0, end));
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
/** The reference path: encodes, so a lone surrogate becomes U+FFFD as it always has. */
function encodedTail(text: string): string {
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
function isHigh(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}
function isLow(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}
function asciiCost(unit: number): number {
  if (unit === 34 || unit === 92) return 2;
  if (unit >= 32) return 1;
  return unit === 8 || unit === 9 || unit === 10 || unit === 12 || unit === 13 ? 2 : 6;
}
/** UTF-8 bytes of a string as `TextEncoder` writes it: a lone surrogate becomes U+FFFD (3). */
function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (isHigh(unit) && isLow(text.charCodeAt(i + 1))) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}
/**
 * The longest suffix of whole characters within the 4 KiB transport budget, and its UTF-8 size,
 * read off the string without encoding it. Undefined when a lone surrogate falls inside it: the
 * encoder would replace that, so the caller takes the encoding path.
 */
function scanTail(text: string): { tail: string; bytes: number } | undefined {
  let start = text.length;
  let size = 0;
  let bytes = 0;
  while (start > 0) {
    const unit = text.charCodeAt(start - 1);
    let width = 1;
    let cost: number;
    if (unit < 0x80) cost = asciiCost(unit);
    else if (unit < 0x800) cost = 2;
    else if (isLow(unit) && start >= 2 && isHigh(text.charCodeAt(start - 2))) {
      cost = 4;
      width = 2;
    } else if (isHigh(unit) || isLow(unit)) return undefined;
    else cost = 3;
    if (size + cost > 4096) break;
    size += cost;
    bytes += unit < 0x80 ? 1 : cost;
    start -= width;
  }
  return { tail: start === 0 ? text : text.slice(start), bytes };
}
/** Whether well-formed text fits one delta's 4 KiB transport budget whole. */
function fitsOneDelta(text: string): boolean {
  let size = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) size += asciiCost(unit);
    else if (unit < 0x800) size += 2;
    else if (isHigh(unit) && isLow(text.charCodeAt(i + 1))) {
      size += 4;
      i++;
    } else if (isHigh(unit) || isLow(unit)) return false;
    else size += 3;
    if (size > 4096) return false;
  }
  return true;
}
/** Split output at whole characters, budgeting both UTF-8 and JSON bytes. */
export function* outputDeltas(text: string): Generator<string> {
  // Most appends fit one delta: then the split below would give the text back unchanged.
  if (fitsOneDelta(text)) {
    yield text;
    return;
  }
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
  const addedBytes = utf8Length(append);
  const bytes = (previous?.bytes ?? 0) + addedBytes;
  const streamId = previous?.streamId ?? outputStreamId(itemId);
  // A leading low surrogate would pair with the previous tail here, never in the encoded path.
  const kept =
    addedBytes >= 4096
      ? scanTail(append)
      : isLow(append.charCodeAt(0))
        ? undefined
        : scanTail((previous?.tail ?? "") + append);
  if (kept) return { streamId, bytes, tail: kept.tail, truncated: bytes > kept.bytes };
  const tail = encodedTail(
    addedBytes >= 4096 ? append : (previous?.tail ?? "") + utf8Slice(append, 4096, true),
  );
  return { streamId, bytes, tail, truncated: bytes > encoder.encode(tail).length };
}
/**
 * Whether a text carries its stream's end, so a delta extends it: a whole text, or a preview
 * marked as the tail. An unmarked preview starts at the head and is whole only when it is as long
 * as the stream.
 */
export function holdsTail(text: string, source: TextSource | undefined): boolean {
  return !source || (source.offset ?? 0) + text.length * 2 === source.bytes;
}
function appendText(
  target: { text: string; source?: TextSource | undefined },
  append: string,
): void {
  const source = target.source;
  if (holdsTail(target.text, source)) target.text += append;
  if (source) target.source = { ...source, bytes: source.bytes + append.length * 2 };
}
/** Text and reasoning both append to reasoning/notice; messages accept only text.
 * Shell output retains a byte count and the last 4 KiB, never the full stream.
 * Returns false for a field that does not belong to the item, without mutation. */
export function acceptsDelta(
  type: Item["type"],
  field: "text" | "reasoning" | "output",
  toolKind?: string,
): boolean {
  if (field === "output") return type === "tool_call" && toolKind === "shell";
  return type === "reasoning" || type === "notice" || (type === "message" && field === "text");
}
export function applyDelta(
  item: Item,
  field: "text" | "reasoning" | "output",
  append: string,
): boolean {
  if (
    !acceptsDelta(item.type, field, item.type === "tool_call" ? item.call.detail.kind : undefined)
  )
    return false;
  if (field === "output" && item.type === "tool_call" && item.call.detail.kind === "shell") {
    item.call.detail.output = summarizeOutput(item.id, append, item.call.detail.output);
  } else if (field !== "output" && (item.type === "reasoning" || item.type === "notice")) {
    appendText(item, append);
  } else if (field === "text" && item.type === "message") {
    const last = item.parts.at(-1);
    if (last?.type === "text") appendText(last, append);
    else item.parts.push({ type: "text", text: append });
  } else return false;
  return true;
}
