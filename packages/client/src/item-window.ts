import type { Item, TextSource } from "@ace/protocol";
import type { Limits } from "./types.ts";

/**
 * Drop `units` from the front of `target`'s text, never splitting a surrogate pair, and move its
 * source's offset past them, so the source still says which part the text holds. Returns the
 * units dropped.
 */
export function dropFront(
  target: { text: string; source?: TextSource | undefined },
  units: number,
): number {
  let cut = Math.min(Math.max(0, units), target.text.length);
  const code = target.text.charCodeAt(cut);
  if (cut && code >= 0xdc00 && code <= 0xdfff) cut++;
  if (!cut) return 0;
  target.text = target.text.slice(cut);
  const source = target.source;
  if (source) target.source = { ...source, offset: (source.offset ?? 0) + cut * 2 };
  return cut;
}
/** The text is part of a longer stream: the daemon sent a preview. */
const preview = (text: string, source: TextSource | undefined) =>
  !!source && source.bytes > text.length * 2;

/**
 * Bound one owned item; no history, notifications or I/O. A long text keeps its newest
 * `limits.text` units (the end is where a stream continues and what a reader wants to see), and a
 * text with a source moves its offset to say which part it still holds.
 */
export function clipItem(item: Item, limits: Pick<Limits, "items" | "text">): boolean {
  let clipped = false;
  if (item.type === "message") {
    if (item.parts.some((part) => part.type === "text" && preview(part.text, part.source)))
      clipped = true;
    if (item.parts.length > limits.items) {
      item.parts = item.parts.slice(-limits.items);
      clipped = true;
    }
    let remaining = Math.max(1, limits.text);
    for (let i = item.parts.length - 1; i >= 0; i--) {
      const part = item.parts[i];
      if (part?.type !== "text") continue;
      if (part.text.length > remaining) {
        clipped = true;
        dropFront(part, part.text.length - remaining);
      }
      remaining = Math.max(0, remaining - part.text.length);
    }
  } else if (item.type === "reasoning" || item.type === "notice") {
    if (preview(item.text, item.source)) clipped = true;
    if (item.text.length > limits.text) {
      clipped = true;
      dropFront(item, item.text.length - Math.max(1, limits.text));
    }
  } else if (item.type === "tool_call" && item.call.detail.kind === "shell")
    if (item.call.detail.output?.truncated) clipped = true;
  return clipped;
}
