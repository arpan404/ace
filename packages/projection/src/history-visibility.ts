import type { Item } from "@ace/protocol";
import { z } from "zod";

const nativeMessage = z.object({
  type: z.string().optional(),
  id: z.string().optional(),
  sessionID: z.string().optional(),
  assistantMessageID: z.string().optional(),
  ordinal: z.number().optional(),
});

/** Bookkeeping stays available as raw history, without taking a transcript row. */
export function isRawHistoryItem(item: Item | undefined): boolean {
  if (!item) return false;
  if (item.type === "notice")
    return (
      item.code === "history.raw-only" ||
      /^Native history record: (?:event_msg|turn_context|session_meta)$/.test(item.text) ||
      item.text === "Native reasoning record" ||
      /^session\.(?:permissions|instructions\.updated)$/.test(item.text) ||
      item.raw.some((raw) => raw.type === "native-notice" || raw.type === "stderr")
    );
  return (
    item.type === "message" &&
    item.raw.some(
      (raw) =>
        raw.type === "projected.message" &&
        "data" in raw &&
        nativeMessage.safeParse(raw.data).data?.type === "system",
    )
  );
}

/** Native identity, never prose, distinguishes replay from a person repeating a message. */
export function historyMessageIdentity(item: Item | undefined): string | undefined {
  if (item?.type !== "message") return undefined;
  if (item.origin?.commandId) return `${item.agentId}:input:${item.origin.commandId}`;
  if (item.nativeId) return `${item.agentId}:${item.role}:${item.nativeId}`;
  for (const raw of item.raw) {
    if (!("data" in raw)) continue;
    const message = nativeMessage.safeParse(raw.data).data;
    if (!message) continue;
    if (raw.type === "projected.message" && message.id)
      return item.role === "assistant"
        ? `${item.agentId}:assistant:${message.id}:0`
        : `${item.agentId}:${item.role}:${message.id}`;
    if (message.assistantMessageID && message.ordinal !== undefined)
      return `${item.agentId}:assistant:${message.assistantMessageID}:${message.ordinal}`;
  }
  return undefined;
}

export function visibleHistoryOrder(
  order: readonly string[],
  item: (id: string) => Item | undefined,
): string[] {
  const identities = new Set<string>();
  return order.filter((id) => {
    const value = item(id);
    if (isRawHistoryItem(value)) return false;
    const identity = historyMessageIdentity(value);
    if (!identity) return true;
    if (identities.has(identity)) return false;
    identities.add(identity);
    return true;
  });
}
