import type { ThreadReader } from "@ace/client";
import { useThread } from "@ace/client-react";
import {
  formatElapsed,
  ledgerOf,
  summarizeWork,
  workCounts,
  type WorkLogHeadline,
} from "@ace/ui-core";
import { useCallback } from "react";
import { flatEqual, useItemsSelect } from "../lib/use-items.ts";

/** Time spent waiting on a person within [from, to], from the thread's shared ledger. */
function useWaited(threadId: string, from: number, to: number): number {
  const read = useCallback(
    (reader: ThreadReader) => (to > from ? ledgerOf(reader).waitedWithin(from, to) : 0),
    [from, to],
  );
  return useThread(threadId, ["interactions"], read) ?? 0;
}

/**
 * Settled summaries time the whole tree from its server run start, excluding human waits.
 * Ongoing logs stay collapsed behind the transcript's live line unless a jump opens one.
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
  const { until, idle = 0 } = options;
  const summary = useItemsSelect(threadId, itemIds, summarizeWork, flatEqual);
  const from = options.startedAt ?? summary?.startedAt ?? 0;
  // Frozen: from the first step to the moment the stretch closed, whatever settles later.
  const to = until ?? summary?.endedAt ?? 0;
  const waited = useWaited(threadId, from, to);
  if (!summary && options.outcome === undefined) return undefined;
  const counts = summary ? workCounts(summary) : "";
  return {
    label:
      options.ongoing || until === undefined
        ? "Working"
        : options.outcome === "paused"
          ? "Paused · Usage limit"
          : `${options.outcome === "interrupted" ? "Stopped after" : options.outcome === "failed" ? "Failed after" : "Worked for"} ${formatElapsed(Math.max(1000, to - from - waited - idle))}`,
    counts,
    running: false,
    current: undefined,
    awaiting: summary?.awaiting ?? false,
  };
}
