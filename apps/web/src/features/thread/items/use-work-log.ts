import { useItem } from "@ace/client-react";
import {
  describeStep,
  summarizeWork,
  workLogHeadline,
  type StepText,
  type WorkLogHeadline,
} from "@ace/ui-core";
import type { Item } from "@ace/protocol";
import { useTicker } from "../lib/clock.ts";
import { flatEqual, useItemsSelect } from "../lib/use-items.ts";

/**
 * A work log's headline, live: re-renders when one of its items changes the summary, and every
 * second only while a step is still running.
 */
export function useWorkLog(
  threadId: string,
  itemIds: readonly string[],
): WorkLogHeadline | undefined {
  const summary = useItemsSelect(threadId, itemIds, summarizeWork, flatEqual);
  const now = useTicker(summary?.running ?? false);
  return summary ? workLogHeadline(summary, now) : undefined;
}

/** One work-log step: the item for its detail and how its row reads. */
export function useToolStep(
  threadId: string,
  itemId: string,
): { item: Item; step: StepText; awaiting: boolean } | undefined {
  const item = useItem(threadId, itemId);
  if (!item) return undefined;
  const awaiting = item.type === "tool_call" && item.call.status === "awaiting_approval";
  return { item, step: describeStep(item), awaiting };
}
