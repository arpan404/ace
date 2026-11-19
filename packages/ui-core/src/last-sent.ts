import type { Item } from "@ace/protocol";
import { mayBeSystemInput, messageText } from "./system-input.ts";

/**
 * A message the person sent in this transcript, for ↑ and ↓ in the composer: `older` 0 is the
 * latest, 1 the one before it, and so on. Inputs ace sent on their behalf (answers, resumes,
 * delegation results) are never theirs. Scans only as far back as it needs. Pure.
 */
export function sentText(
  transcript: {
    readonly order: readonly string[];
    item(id: string): Item | undefined;
  },
  older: number,
): string | undefined {
  const { order } = transcript;
  let skip = older;
  for (let index = order.length - 1; index >= 0; index--) {
    const id = order[index];
    const item = id === undefined ? undefined : transcript.item(id);
    if (item?.type !== "message" || item.role !== "user" || item.synthetic) continue;
    if (mayBeSystemInput(item)) continue;
    const text = messageText(item);
    if (!text.trim()) continue;
    if (skip === 0) return text;
    skip--;
  }
  return undefined;
}
