import type { Item } from "@ace/protocol";
import { mayBeSystemInput, messageText } from "@ace/ui-core";

/** How far back ↑ looks for the person's last message in the loaded transcript. */
const lookback = 200;

/**
 * The text of the last message the person sent in this transcript, for ↑ in an empty composer.
 * Inputs ace sent on their behalf (answers, resumes, delegation results) are never theirs. Pure.
 */
export function lastSentText(transcript: {
  readonly order: readonly string[];
  item(id: string): Item | undefined;
}): string | undefined {
  const { order } = transcript;
  for (let index = order.length - 1; index >= Math.max(0, order.length - lookback); index--) {
    const id = order[index];
    const item = id === undefined ? undefined : transcript.item(id);
    if (item?.type !== "message" || item.role !== "user" || item.synthetic) continue;
    if (mayBeSystemInput(item)) continue;
    const text = messageText(item);
    if (text.trim()) return text;
  }
  return undefined;
}
