import type { Item } from "@ace/protocol";

type Notice = Extract<Item, { type: "notice" }>;

/** The operation a delivery-error notice names, when it names one. */
function operationOf(notice: Notice): unknown {
  for (const raw of notice.raw) {
    if (raw.type !== "delivery_error") continue;
    const data: unknown = "data" in raw ? raw.data : undefined;
    if (typeof data === "object" && data !== null && "operation" in data) return data.operation;
  }
  return undefined;
}

/**
 * The command whose message the daemon says it couldn't deliver, when `item` is that notice:
 * an error with the command named, for a send or a thread start. "May have run"
 * (`delivery_uncertain`) is not "Not sent": it keeps its own notice, and no Retry (ADR 0065).
 * A failed switch, Stop or answer is its own error row. Pure.
 */
export function notSentCommand(item: Item | undefined): string | undefined {
  if (item?.type !== "notice" || item.level !== "error" || !item.commandId) return undefined;
  if (!item.code?.startsWith("delivery_") || item.code === "delivery_uncertain") return undefined;
  const operation = operationOf(item);
  if (operation !== undefined && operation !== "thread.send" && operation !== "thread.create")
    return undefined;
  return item.commandId;
}
