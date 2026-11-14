import { z } from "zod";
import { ItemId, ThreadId } from "./ids.ts";
import { RawPayload } from "./provider-data.ts";

const requestId = z.string().min(1).max(256);

/**
 * One item's verbatim provider payloads, for a client whose hello asked for `raw-on-demand`
 * and so got the item without them (`rawOmitted`). Read when a raw-frames view opens.
 */
export const ItemRawRequest = z.object({
  type: z.literal("item.raw"),
  requestId,
  threadId: ThreadId,
  itemId: ItemId,
  /** Index of the first payload to read: 0, or a previous reply's `next`. */
  from: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  /** With `from` past 0: the `revision` of the reply that gave it. */
  revision: z.string().min(1).max(128).optional(),
});
export type ItemRawRequest = z.infer<typeof ItemRawRequest>;

export const ItemRawResponse = z.object({
  type: z.literal("item.raw"),
  requestId,
  threadId: ThreadId,
  itemId: ItemId,
  /**
   * Which version of the item's payloads this page is of. A continuation names it; if the
   * payloads changed since, the reply says `changed` and holds none.
   */
  revision: z.string().min(1).max(128),
  /** The payloads changed after the cursor was issued: read again from 0. */
  changed: z.literal(true).optional(),
  /** Index of `raw[0]` among the item's payloads: the request's `from`. */
  from: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  /**
   * The item's `raw`, or a tool call's `call.raw`, as stored, oldest first, from `from` on: as
   * many as fit one reply (1 MiB of JSON), never none while any remain. An entry too large for
   * a reply alone comes with its long fields cut, each ending `… [cut: <n> bytes]`; storage
   * keeps it whole.
   */
  raw: z.array(RawPayload),
  /** Where the next page starts, when payloads are left; absent at the end. */
  next: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
});
export type ItemRawResponse = z.infer<typeof ItemRawResponse>;
