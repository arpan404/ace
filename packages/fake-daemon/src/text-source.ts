import type { Item, ThreadView } from "@ace/protocol";

/** The item and part a clipped preview's `text:[itemId, part]` source names (`window.ts`). */
function named(streamId: string): { itemId: string; part: number } | undefined {
  if (!streamId.startsWith("text:")) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(streamId.slice("text:".length));
  } catch {
    return undefined;
  }
  if (!Array.isArray(value) || typeof value[0] !== "string" || !Number.isSafeInteger(value[1]))
    return undefined;
  return { itemId: value[0], part: Number(value[1]) };
}

function textOf(item: Item, part: number): string | undefined {
  if (item.type === "message") {
    const found = item.parts[part];
    return found?.type === "text" ? found.text : undefined;
  }
  return (item.type === "reasoning" || item.type === "notice") && part === 0
    ? item.text
    : undefined;
}

/**
 * A page of a clipped text's whole, as UTF-16LE bytes from offset `offset`, as the daemon serves
 * its item text streams over `output.read`. A text still streaming reads to its current end.
 * Undefined for a stream that names no text here.
 */
export function readTextSource(
  views: Iterable<ThreadView>,
  streamId: string,
  offset: number,
  limit: number,
): { bytes: Uint8Array; nextOffset: number; eof: boolean } | undefined {
  const source = named(streamId);
  if (!source) return undefined;
  for (const view of views) {
    const item = Object.hasOwn(view.items, source.itemId) ? view.items[source.itemId] : undefined;
    const text = item && textOf(item, source.part);
    if (text === undefined) continue;
    const size = text.length * 2;
    if (offset > size) return undefined;
    const end = Math.min(size, offset + limit);
    const bytes = new Uint8Array(end - offset);
    for (let at = offset; at < end; at++) {
      const unit = text.charCodeAt(at >> 1);
      bytes[at - offset] = at % 2 === 0 ? unit & 0xff : unit >> 8;
    }
    return { bytes, nextOffset: end, eof: end >= size };
  }
  return undefined;
}
