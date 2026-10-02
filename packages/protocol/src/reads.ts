import { z } from "zod";
import { ThreadId, ItemId } from "./ids.ts";
import { Item } from "./items.ts";

export const ReadPayload = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("items.page"),
    threadId: ThreadId,
    before: ItemId.optional(),
    limit: z.number().int().min(1).max(200),
  }),
  z.object({
    type: z.literal("output.read"),
    threadId: ThreadId,
    itemId: ItemId,
    offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    limit: z.number().int().min(1).max(262144),
  }),
]);
export type ReadPayload = z.infer<typeof ReadPayload>;
export const ItemsPage = z.object({
  type: z.literal("items.page"),
  items: z.array(Item).max(200),
  itemsBefore: ItemId.nullable(),
});
export const OutputRead = z.object({
  type: z.literal("output.read"),
  text: z.string().max(262144),
  nextOffset: z.number().int().nonnegative(),
  done: z.boolean(),
});
export const ReadResult = z.discriminatedUnion("type", [ItemsPage, OutputRead]);
export type ReadResult = z.infer<typeof ReadResult>;
export const ReadRequest = z.object({
  type: z.literal("request"),
  requestId: z.string().min(1),
  payload: ReadPayload,
});
export const ReadResponse = z
  .object({ type: z.literal("response"), requestId: z.string().min(1) })
  .and(
    z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), result: ReadResult }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  );
export type ReadResponse = z.infer<typeof ReadResponse>;
