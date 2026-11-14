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
});
export type ItemRawRequest = z.infer<typeof ItemRawRequest>;

export const ItemRawResponse = z.object({
  type: z.literal("item.raw"),
  requestId,
  threadId: ThreadId,
  itemId: ItemId,
  /** The item's `raw`, or a tool call's `call.raw`, as stored, oldest first. */
  raw: z.array(RawPayload),
  /** Payloads past the reply's size limit were left out; `raw` holds the oldest that fit. */
  truncated: z.boolean().optional(),
});
export type ItemRawResponse = z.infer<typeof ItemRawResponse>;
