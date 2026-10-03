import { type DelegationOutcome, type Item, type Thread } from "@ace/protocol";
import type { Store } from "../store.ts";

/** One small page is sufficient for an outcome preview; full content stays in the payload store. */
export function threadOutcome(store: Store, thread: Thread, cancelled = false): DelegationOutcome {
  const page = store.readItemPage(thread.id, store.headSeq() + 1, 20, 48 * 1024);
  let message: Extract<Item, { type: "message" }> | undefined;
  for (const item of page.items)
    if (item.type === "message" && item.role === "assistant") message = item;
  let remaining = 1024; // 4 KiB worst case UTF-8, including surrogate-safe truncation below.
  const parts: string[] = [];
  let truncated = page.itemsBefore !== null;
  for (const part of message?.parts ?? []) {
    if (part.type !== "text") continue;
    let units = 0;
    for (const point of part.text) {
      if (units + point.length > remaining) break;
      units += point.length;
    }
    const text = part.text.slice(0, units);
    parts.push(text);
    remaining -= text.length + 1;
    truncated ||= text.length < part.text.length || part.source !== undefined;
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
