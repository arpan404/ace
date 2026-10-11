import { z } from "zod";
import { AgentId, ItemId, SearchKind, ThreadId, ToolKind } from "@ace/protocol";

/** A source may replay an item as bounded search text and immutable text sources. */
export const SearchReplayItem = z.object({
  type: z.literal("search.item"),
  item: z.object({
    id: ItemId,
    agentId: AgentId,
    type: SearchKind.exclude(["thread"]),
    createdAt: z.number(),
    complete: z.boolean(),
    toolKind: ToolKind.optional(),
  }),
  title: z.string(),
  body: z.string(),
  segments: z.array(
    z.object({
      name: z.string(),
      category: z.string(),
      text: z.string(),
      source: z.object({
        streamId: z.string(),
        bytes: z.number().int().nonnegative(),
        encoding: z.enum(["utf-8", "utf-16le"]),
      }),
    }),
  ),
});
export type SearchReplayItem = z.infer<typeof SearchReplayItem>;
export const SearchReplayEvent = z.object({
  seq: z.number().int().nonnegative(),
  id: z.string(),
  threadId: ThreadId,
  at: z.number(),
  payload: SearchReplayItem,
});
export type SearchReplayEvent = z.infer<typeof SearchReplayEvent>;
