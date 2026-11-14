import type { RawPayload } from "@ace/protocol";
import type { SocketContext, SocketService } from "./socket.ts";

/** The most raw JSON one `item.raw` reply carries; the rest is marked `truncated`. */
export const itemRawReplyBytes = 1024 * 1024;

/** The oldest payloads that fit `limit` bytes of JSON, and whether any were left out. */
function fitting(raw: readonly RawPayload[], limit: number) {
  const kept: RawPayload[] = [];
  let bytes = 2;
  for (const payload of raw) {
    bytes += Buffer.byteLength(JSON.stringify(payload)) + 1;
    if (bytes > limit) return { raw: kept, truncated: true };
    kept.push(payload);
  }
  return { raw: kept, truncated: false };
}

/**
 * `item.raw`: one item's verbatim provider payloads, which a client on the `raw-on-demand` trim
 * got the item without. Read under the same checks as the item itself: read scope, and a
 * thread this device may read.
 */
export function createItemRawSession(context: SocketContext): SocketService {
  return {
    handle(message) {
      if (message.type !== "item.raw") return false;
      const scope = { requestId: message.requestId };
      if (!context.authorize("read") || !context.canReadThread(message.threadId)) {
        context.fail("forbidden", "Thread is not readable", false, scope);
        return true;
      }
      let stored: RawPayload[] | undefined;
      try {
        stored = context.options.store.itemRaw(message.threadId, message.itemId);
      } catch {
        context.fail("item_raw_failed", "Could not read the item", false, scope);
        return true;
      }
      if (!stored) {
        context.fail("item_not_found", "No such item in this thread", false, scope);
        return true;
      }
      const { raw, truncated } = fitting(stored, itemRawReplyBytes);
      context.send({
        type: "item.raw",
        requestId: message.requestId,
        threadId: message.threadId,
        itemId: message.itemId,
        raw,
        ...(truncated ? { truncated } : {}),
      });
      return true;
    },
  };
}
