import type { RawPayload } from "@ace/protocol";
import type { SocketContext, SocketService } from "./socket.ts";

/** The most raw JSON one `item.raw` reply carries; the rest comes in later pages. */
export const itemRawReplyBytes = 1024 * 1024;

/**
 * The payloads from `from` that fit `limit` bytes of JSON, at least one while any remain (a
 * stored entry is at most 64 KiB inline, larger ones are blob references), and where the next
 * page starts.
 */
function page(raw: readonly RawPayload[], from: number, limit: number) {
  const kept: RawPayload[] = [];
  let bytes = 2;
  let index = from;
  for (; index < raw.length; index++) {
    const payload = raw[index];
    if (payload === undefined) break;
    bytes += Buffer.byteLength(JSON.stringify(payload)) + 1;
    if (kept.length && bytes > limit) break;
    kept.push(payload);
  }
  return { raw: kept, next: index < raw.length ? index : undefined };
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
      const { raw, next } = page(stored, message.from, itemRawReplyBytes);
      context.send({
        type: "item.raw",
        requestId: message.requestId,
        threadId: message.threadId,
        itemId: message.itemId,
        from: message.from,
        raw,
        ...(next === undefined ? {} : { next }),
      });
      return true;
    },
  };
}
