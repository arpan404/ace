import type { Item } from "@ace/protocol";

/*
 * A message the daemon kept because its send or session start failed: the one short reason its
 * "Not sent" line says, and the technical detail behind Details. Pure.
 */

/** One short sentence for the "Not sent" line; the rest of a longer reason goes to Details. */
export function shortReason(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) return undefined;
  const end = trimmed.search(/[.!?](\s|$)/);
  const sentence = end === -1 ? trimmed : trimmed.slice(0, end);
  return sentence.length > 96 ? `${sentence.slice(0, 95).trimEnd()}…` : sentence;
}

/**
 * The daemon's newest notice about a kept message (`input_queued` for its command id), which holds
 * the reason it wasn't sent. Retries update the same notice, so this follows the latest attempt.
 * Scans from the newest item back.
 */
export function retainedInputNotice(
  transcript: { readonly order: readonly string[]; item(id: string): Item | undefined },
  commandId: string,
): Extract<Item, { type: "notice" }> | undefined {
  for (let at = transcript.order.length - 1; at >= 0; at--) {
    const item = transcript.item(transcript.order[at] ?? "");
    if (item?.type === "notice" && item.code === "input_queued" && item.commandId === commandId)
      return item;
  }
  return undefined;
}
