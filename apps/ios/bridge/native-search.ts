import type { ClientCore } from "@ace/client";
import { ThreadId, ItemId } from "@ace/protocol";
import { z } from "zod";
import { itemRow } from "./presentation.ts";
import { itemDetail } from "./thread-rows.ts";

/** A search result opens a separate bounded history window, leaving the live tail intact. */
export const NativeHistoryWindow = z
  .object({
    type: z.literal("native.history.window"),
    threadId: ThreadId,
    itemId: ItemId.optional(),
    aroundSeq: z.number().int().nonnegative().optional(),
  })
  .refine((value) => (value.itemId === undefined) !== (value.aroundSeq === undefined));

export async function readHistoryWindow(
  owner: ClientCore,
  query: z.infer<typeof NativeHistoryWindow>,
  signal: AbortSignal,
) {
  const page = await owner.itemsWindow(
    {
      threadId: query.threadId,
      ...(query.itemId === undefined ? { aroundSeq: query.aroundSeq } : { itemId: query.itemId }),
      before: 30,
      after: 30,
    },
    { signal },
  );
  return {
    target: page.targetSeq,
    before: page.itemsBefore,
    after: page.itemsAfter,
    rows: page.items.map((item) =>
      Object.assign(itemRow(item), itemDetail(item), { seq: page.itemSeqs[item.id] }),
    ),
  };
}
