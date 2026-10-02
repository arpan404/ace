import type { ReadPayload, ReadResult } from "@ace/protocol";
import { outputSlice } from "./output-slice.ts";
import type { Store } from "./store.ts";

/** Compatibility reads until output chunks and indexed item windows land. */
export function read(store: Store, payload: ReadPayload): ReadResult {
  const view = store.acquireThread(payload.threadId);
  try {
    if (payload.type === "items.page") {
      const end =
        payload.before === undefined
          ? view.itemOrder.length
          : view.itemOrder.indexOf(payload.before);
      if (end < 0) throw new Error("invalid_cursor");
      const items = [];
      let bytes = 0;
      let start = end;
      while (start > 0 && items.length < payload.limit) {
        const id = view.itemOrder[start - 1];
        const item = id ? view.items[id] : undefined;
        if (!item) {
          start--;
          continue;
        }
        const size = Buffer.byteLength(JSON.stringify(item));
        if (bytes + size > 1024 * 1024) {
          if (!items.length) throw new Error("item_too_large");
          break;
        }
        bytes += size;
        items.push(item);
        start--;
      }
      items.reverse();
      return { type: "items.page", items, itemsBefore: start > 0 ? (items[0]?.id ?? null) : null };
    }
    const item = view.items[payload.itemId];
    if (item?.type !== "tool_call" || item.call.detail.kind !== "shell")
      throw new Error("output_not_found");
    const output = item.call.detail.output ?? "";
    // Offsets are UTF-16 units for the legacy string representation.
    const text = outputSlice(output, payload.offset, payload.limit);
    const nextOffset = payload.offset + text.length;
    return { type: "output.read", text, nextOffset, done: nextOffset >= output.length };
  } finally {
    store.releaseThread(payload.threadId);
  }
}
