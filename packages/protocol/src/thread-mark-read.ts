import { z } from "zod";
import { ThreadId } from "./ids.ts";

/*
 * Marking a thread read is a command, so the core stream's command union needs it; the
 * long-thread reads beside it in `long-thread.ts` are service requests the core does not load
 * (ADR 0056).
 */
export const ThreadMarkReadCommand = z.object({
  type: z.literal("thread.markRead"),
  threadId: ThreadId,
  lastSeenSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export type ThreadMarkReadCommand = z.infer<typeof ThreadMarkReadCommand>;
