import { z } from "zod";
import { ThreadId } from "./ids.ts";
import { Item } from "./items.ts";

export const HandoffPageInput = z.strictObject({
  sourceThreadId: ThreadId,
  before: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  limit: z.number().int().min(1).max(50).default(50),
});
export const HandoffPage = z.object({
  threadId: ThreadId,
  items: z.array(Item).max(50),
  itemsBefore: z.number().int().positive().nullable(),
});
export const HandoffChunkInput = z.strictObject({
  sourceThreadId: ThreadId,
  streamId: z.string().min(1).max(1024),
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  limit: z.number().int().min(1).max(32768).default(32768),
});
export const HandoffChunk = z.object({
  bytes: z.string().max(43692),
  encoding: z.enum(["utf-16le", "utf-8"]),
  nextOffset: z.number().int().nonnegative(),
  eof: z.boolean(),
});
