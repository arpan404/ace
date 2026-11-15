import type { RawPayload } from "@ace/protocol";
import type { SocketContext, SocketService } from "./socket.ts";
import { pageReplyBytes } from "../reply-bounds.ts";

/**
 * The most one `item.raw` reply may be, as sent: its whole JSON, envelope included. Pages fill to
 * `pageReplyBytes` of raw JSON; an entry storage keeps (data inline up to 64 KiB) goes whole,
 * alone when it fills a page, as long as the reply around it stays within this; a larger one has
 * its long fields cut.
 */
export const itemRawReplyBytes = pageReplyBytes + 8 * 1024;
/** What a cut field keeps of itself. */
const keptBytes = 4 * 1024;

const json = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? "");

/** `text` cut to its first `keptBytes`, saying it was cut and how long it was. */
function cut(text: string): string {
  const bytes = Buffer.byteLength(text);
  if (bytes <= keptBytes) return text;
  // A whole-character prefix: cut by bytes, drop a broken last character.
  const kept = Buffer.from(text).subarray(0, keptBytes).toString("utf8").replace(/�$/, "");
  return `${kept}… [cut: ${bytes} bytes]`;
}

/**
 * `payload` as one reply may carry it: whole when it fits `entryBytes`, else with `type`,
 * `name` and any preview cut, and inline data larger than `keptBytes` replaced by the start of
 * its JSON, cut the same way. The stored entry is never changed.
 */
function bounded(payload: RawPayload, entryBytes: number): RawPayload {
  if (json(payload) <= entryBytes) return payload;
  const cutEntry = cutFields(payload);
  // Long fields cut to `keptBytes` each fit; if escaping still made it too long, its type and
  // how long it was are what remain.
  return json(cutEntry) <= entryBytes
    ? cutEntry
    : { type: payload.type.slice(0, 256), data: `[cut: ${json(payload)} bytes]` };
}

function cutFields(payload: RawPayload): RawPayload {
  const name = payload.name === undefined ? {} : { name: cut(payload.name) };
  if (!("data" in payload))
    return {
      ...payload,
      type: cut(payload.type),
      ...name,
      ...(payload.preview === undefined ? {} : { preview: cut(payload.preview) }),
    };
  const data = json(payload.data) <= keptBytes ? payload.data : cut(JSON.stringify(payload.data));
  return { type: cut(payload.type), ...name, data };
}

/**
 * The payloads `entries` yields, taken one at a time until `fill` bytes of JSON (the array's
 * brackets and commas included), at least one while any remain, and never past `most`; where the
 * next page starts (`from` + taken) if one is left. At most one entry past the page is read: the
 * one that did not fit.
 */
function page(entries: Iterator<RawPayload>, from: number, fill: number, most: number) {
  const kept: RawPayload[] = [];
  let bytes = 2;
  for (let entry = entries.next(); !entry.done; entry = entries.next()) {
    // Alone on its page, an entry may take everything but the brackets.
    const sent = bounded(entry.value, most - 2);
    bytes += json(sent) + (kept.length ? 1 : 0);
    if (kept.length && bytes > Math.min(fill, most)) {
      entries.return?.();
      return { raw: kept, next: from + kept.length };
    }
    kept.push(sent);
  }
  return { raw: kept, next: undefined };
}

/**
 * `item.raw`: one item's verbatim provider payloads, which a client on the `raw-on-demand` trim
 * got the item without. Read under the same checks as the item itself: read scope, and a
 * thread this device may read. A page continues only the version of the payloads it began
 * (`revision`, from the item's head row: no page reads more of them than it sends).
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
      const store = context.options.store;
      let revision: string | undefined;
      try {
        revision = store.itemRawRevision(message.threadId, message.itemId);
      } catch {
        context.fail("item_raw_failed", "Could not read the item", false, scope);
        return true;
      }
      if (revision === undefined) {
        context.fail("item_not_found", "No such item in this thread", false, scope);
        return true;
      }
      const reply = {
        type: "item.raw" as const,
        requestId: message.requestId,
        threadId: message.threadId,
        itemId: message.itemId,
        revision,
        from: message.from,
      };
      // A continuation of another version, or one with no version at all, starts again; the
      // payloads are not read.
      if (message.from > 0 && message.revision !== revision) {
        context.send({ ...reply, changed: true, raw: [] });
        return true;
      }
      // What the reply takes around its payloads, with the longest `next` it could carry: the
      // payloads get the rest of `itemRawReplyBytes`.
      const envelope = json({ ...reply, raw: [], next: Number.MAX_SAFE_INTEGER }) - 2;
      let raw: RawPayload[];
      let next: number | undefined;
      try {
        ({ raw, next } = page(
          store.itemRawEntries(message.threadId, message.itemId, message.from),
          message.from,
          pageReplyBytes,
          itemRawReplyBytes - envelope,
        ));
      } catch {
        context.fail("item_raw_failed", "Could not read the item", false, scope);
        return true;
      }
      context.send({ ...reply, raw, ...(next === undefined ? {} : { next }) });
      return true;
    },
  };
}
