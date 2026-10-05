import type { ThreadReader } from "@ace/client";
import { useThread } from "@ace/client-react";
import {
  activityText,
  formatElapsed,
  ledgerOf,
  summarizeWork,
  workCounts,
  type WorkLogHeadline,
} from "@ace/ui-core";
import { useCallback } from "react";
import { useTicker } from "../lib/clock.ts";
import { flatEqual, useItemsSelect } from "../lib/use-items.ts";
import { useTurnActivity } from "../transcript/use-turn-activity.ts";

/** Time spent waiting on a person within [from, to], from the thread's shared ledger. */
function useWaited(threadId: string, from: number, to: number): number {
  const read = useCallback(
    (reader: ThreadReader) => (to > from ? ledgerOf(reader).waitedWithin(from, to) : 0),
    [from, to],
  );
  return useThread(threadId, ["interactions"], read) ?? 0;
}

/**
 * A work log's headline. At rest it reads "Worked for 4m 12s": from its first step to `until`,
 * the moment its stretch closed (the agent spoke, the turn ended), less any wait on the person
 * in between, so a step that settles later never changes it; a log still open runs to its
 * newest step. It never ticks: a step still unsettled shows
 * that on its own row. Only `live`, the bottom log of a turn the agent is working on, carries
 * the turn's live line ("Working for …", ticking), the same line the footer would otherwise show.
 */
export function useWorkLog(
  threadId: string,
  itemIds: readonly string[],
  live = false,
  until?: number,
): WorkLogHeadline | undefined {
  const summary = useItemsSelect(threadId, itemIds, summarizeWork, flatEqual);
  const from = summary?.startedAt ?? 0;
  // Frozen: from the first step to the moment the stretch closed, whatever settles later.
  const to = until ?? summary?.endedAt ?? 0;
  const waited = useWaited(threadId, from, to);
  const activity = useTurnActivity(threadId, live);
  const now = useTicker(activity?.elapsedFrom !== undefined);
  if (!summary) return undefined;
  const counts = workCounts(summary);
  if (activity)
    return {
      label: activityText(activity, now),
      counts,
      running: true,
      current: activity.current,
      awaiting: summary.awaiting,
    };
  return {
    label: `Worked for ${formatElapsed(Math.max(1000, to - from - waited))}`,
    counts,
    running: false,
    current: undefined,
    awaiting: summary.awaiting,
  };
}
