import { z } from "zod";
import { Agent, Item, Thread, ThreadId } from "@ace/protocol/entities";
const Bytes = z.custom<Uint8Array>((v) => v instanceof Uint8Array);
export const ArchiveCommand = z.discriminatedUnion("type", [
  z.object({ type: z.literal("begin"), thread: Thread }),
  z.object({ type: z.literal("agent"), agent: Agent }),
  z.object({ type: z.literal("item"), item: Item }),
  z.object({
    type: z.literal("blob.start"),
    id: z.string(),
    bytes: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("blob.chunk"),
    id: z.string(),
    bytes: Bytes.refine((v) => v.byteLength <= 64 * 1024),
  }),
  z.object({ type: z.literal("blob.end"), id: z.string() }),
  z.object({ type: z.literal("commit") }),
  z.object({ type: z.literal("rollback") }),
]);
export const PageRequest = z.object({
  threadId: ThreadId,
  after: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(200).default(200),
});
export const PageResponse = z.object({
  items: z.array(Item).max(200),
  next: z.number().nullable(),
});
export const BlobRequest = z.object({
  id: z.string(),
  offset: z.number().int().nonnegative(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(256 * 1024),
});
export const BlobResponse = z.object({ bytes: Bytes, size: z.number().int().nonnegative() });
export const ArchiveThread = Thread.nullable();
