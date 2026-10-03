import type { Item } from "@ace/protocol";
import type { Limits } from "./types.ts";
/** Bound one owned item; no history, notifications or I/O. */
export function clipItem(item: Item, limits: Pick<Limits, "items" | "text">): boolean {
  let clipped = false;
  const cut = (text: string) => {
    if (text.length <= limits.text) return text;
    clipped = true;
    return text.slice(-Math.max(1, Math.floor(limits.text / 2)));
  };
  if (item.type === "message") {
    if (
      item.parts.some(
        (part) => part.type === "text" && part.source && part.source.bytes > part.text.length * 2,
      )
    )
      clipped = true;
    if (item.parts.length > limits.items) {
      item.parts = item.parts.slice(-limits.items);
      clipped = true;
    }
    const first = item.parts[0];
    if (item.parts.length === 1 && first?.type === "text") {
      first.text = cut(first.text);
      return clipped;
    }
    let remaining = limits.text;
    for (let i = item.parts.length - 1; i >= 0; i--) {
      const part = item.parts[i];
      if (part?.type === "text") {
        if (part.text.length > remaining) {
          clipped = true;
          part.text = remaining ? part.text.slice(-remaining) : "";
        }
        remaining -= part.text.length;
      }
    }
  } else if (item.type === "reasoning" || item.type === "notice") {
    if (item.source && item.source.bytes > item.text.length * 2) clipped = true;
    item.text = cut(item.text);
  } else if (item.type === "tool_call" && item.call.detail.kind === "shell")
    if (item.call.detail.output?.truncated) clipped = true;
  return clipped;
}
