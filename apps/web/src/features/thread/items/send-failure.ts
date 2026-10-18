import type { CommandPayload, Item } from "@ace/protocol";
import { refusalMessage } from "@/lib/daemon-command.ts";

/** The daemon's limit on one message: its command, as JSON. */
export const messageLimitBytes = 256 * 1024;

const kilobytes = (bytes: number) => `${Math.ceil(bytes / 1024)} KB`;

/**
 * Why a message wasn't sent, in words for its "Not sent" line, e.g. "Too long: 312 KB, the
 * limit is 256 KB" (`payload` lets the size be said). `code` is the daemon's refusal or the
 * client's own failure (`limit`, `storage`).
 */
export function sendFailure(code: string | undefined, payload?: CommandPayload): string {
  if (code === "message_too_large" && payload) {
    const bytes = new TextEncoder().encode(JSON.stringify(payload)).length;
    return `Too long: ${kilobytes(bytes)}, the limit is ${kilobytes(messageLimitBytes)}`;
  }
  if (code === "limit") return "This device has too much waiting to send. Try again in a moment.";
  if (code === "storage") return "This browser couldn't save the message.";
  return code ? refusalMessage(code) : "ace didn't take it.";
}

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
