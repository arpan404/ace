import { useItem } from "@ace/client-react";
import {
  describeStep,
  summarizeWork,
  workLogHeadline,
  type StepText,
  type WorkLogHeadline,
} from "@ace/ui-core";
import type { Item } from "@ace/protocol";
import { useChangesStat } from "@/lib/diffs/use-file-diffs.ts";
import { useTicker } from "../lib/clock.ts";
import { flatEqual, useItemsSelect } from "../lib/use-items.ts";

/**
 * A work log's headline, live: re-renders when one of its items changes the summary, and every
 * second only while a step is still running. `live` marks the log the agent is still adding to
 * (the last block of an open turn), which reads "Working for …" between steps too.
 */
export function useWorkLog(
  threadId: string,
  itemIds: readonly string[],
  live = false,
): WorkLogHeadline | undefined {
  const selected = useItemsSelect(threadId, itemIds, summarizeWork, flatEqual);
  const summary = selected && live && !selected.running ? { ...selected, running: true } : selected;
  const now = useTicker(summary?.running ?? false);
  return summary ? workLogHeadline(summary, now) : undefined;
}

/** One work-log step: the item for its detail and how its row reads. */
export function useToolStep(
  threadId: string,
  itemId: string,
): { item: Item; step: StepText; awaiting: boolean } | undefined {
  const item = useItem(threadId, itemId);
  const described = item && describeStep(item);
  // A full-text edit's stat is a text diff, counted in the diff worker rather than here.
  const counted = useChangesStat(described?.diffFor);
  if (!item || !described) return undefined;
  const awaiting = item.type === "tool_call" && item.call.status === "awaiting_approval";
  const step = counted ? { ...described, ...counted } : described;
  return { item, step, awaiting };
}
