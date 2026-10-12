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
 * A work log's headline. Settled turn summaries use the server run start and tree end;
 * live segments stay quiet while the transcript footer owns the ticking line. From its first step to `until`,
 * the moment its stretch closed (the agent answered, the turn ended), less any wait on the
 * person and any `idle` time between two runs in between, so a step that settles later never
 * changes it; a log still open runs to its newest step. It never ticks: a step still unsettled
 * shows that on its own row. Live logs keep a quiet "Work so far" headline; transient
 * working status belongs to the composer. Waiting and held states retain their context.
 */
export function useWorkLog(
  threadId: string,
  itemIds: readonly string[],
  options: {
    ongoing?: boolean | undefined;
    live?: boolean | undefined;
    until?: number | undefined;
    idle?: number | undefined;
    startedAt?: number | undefined;
    outcome?: "completed" | "interrupted" | "failed" | "paused" | undefined;
  },
): WorkLogHeadline | undefined {
  const { live = false, until, idle = 0 } = options;
  const summary = useItemsSelect(threadId, itemIds, summarizeWork, flatEqual);
  const from = options.startedAt ?? summary?.startedAt ?? 0;
  // Frozen: from the first step to the moment the stretch closed, whatever settles later.
  const to = until ?? summary?.endedAt ?? 0;
  const waited = useWaited(threadId, from, to);
  const activity = useTurnActivity(threadId, live || !!options.ongoing);
  const now = useTicker(activity?.elapsedFrom !== undefined);
  if (!summary && options.outcome === undefined) return undefined;
  const counts = summary ? workCounts(summary) : "";
  if (activity && activity.tone !== "working" && !activity.label.startsWith("Watching"))
    return {
      label: activityText(activity, now),
      counts,
      running: false,
      current: activity.current,
      awaiting: summary?.awaiting ?? false,
    };
  return {
    label:
      options.ongoing || until === undefined
        ? activity
          ? activityText(activity, now)
          : "Working"
        : options.outcome === "paused"
          ? "Paused · Usage limit"
          : `${options.outcome === "interrupted" ? "Stopped after" : options.outcome === "failed" ? "Failed after" : "Worked for"} ${formatElapsed(Math.max(1000, to - from - waited - idle))}`,
    counts,
    running: false,
    current: undefined,
    awaiting: summary?.awaiting ?? false,
  };
}
