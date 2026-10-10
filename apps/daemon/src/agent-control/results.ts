import { type DelegationOutcome, type Item, type Thread } from "@ace/protocol";
import type { Store } from "../store.ts";

/** One small page is sufficient for an outcome preview; full content stays in the payload store. */
export function threadOutcome(store: Store, thread: Thread, cancelled = false): DelegationOutcome {
  const page = store.readItemPage(thread.id, store.headSeq() + 1, 20, 48 * 1024);
  let message: Extract<Item, { type: "message" }> | undefined;
  for (const item of page.items)
    if (item.type === "message" && item.role === "assistant") message = item;
  let remaining = 4096; // Schema bound in UTF-16 units; never split a surrogate pair.
  const parts: string[] = [];
  let truncated = page.itemsBefore !== null;
  for (const part of message?.parts ?? []) {
    if (part.type !== "text") continue;
    let content = part.text;
    let sourceTruncated = part.source !== undefined;
    if (part.source && store.outputThread(part.source.streamId) === thread.id) {
      const read = store.readOutputBytes(part.source.streamId, 0, Math.max(2, (remaining + 1) * 2));
      content = read.bytes.toString("utf16le");
      sourceTruncated = !read.eof;
    }
    let units = 0;
    for (const point of content) {
      if (units + point.length > remaining) break;
      units += point.length;
    }
    const text = content.slice(0, units);
    parts.push(text);
    remaining -= text.length + 1;
    truncated ||= text.length < content.length || sourceTruncated;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
  }
  const result = parts.join("\n");
  return {
    threadId: thread.id,
    outcome: cancelled ? "cancelled" : thread.status.state === "failed" ? "failed" : "completed",
    result,
    truncated,
    before: page.itemsBefore,
  };
}
