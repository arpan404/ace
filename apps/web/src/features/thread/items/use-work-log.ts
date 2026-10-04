import { summarizeWork, workLogHeadline, type WorkLogHeadline } from "@ace/ui-core";
import { useTicker } from "../lib/clock.ts";
import { flatEqual, useItemsSelect } from "../lib/use-items.ts";
import { useStepDisplay } from "./use-step-display.ts";

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

/**
 * One work-log step: the item for its detail and how its row reads. The row's wording (paths,
 * commands, approvals, failures) is WP2's step display.
 */
export const useToolStep = useStepDisplay;
