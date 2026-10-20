import type { ThreadReader } from "@ace/client";
import { useThread } from "@ace/client-react";
import type { TurnSummary } from "@ace/protocol";
import { ledgerOf, summarizeWork, turnHeadLabel, type TurnOutcome } from "@ace/ui-core";
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
 * A settled log's head: "Worked for 2m 5s" over the whole tree, excluding human waits and idle
 * gaps, and when the turn ended. With the turn's summary from the daemon (`turns.page`), its
 * time is the turn's own, however much of it the thread has loaded; until then, the loaded items'.
 */
export function useWorkLog(
  threadId: string,
  itemIds: readonly string[],
  options: {
    until?: number | undefined;
    idle?: number | undefined;
    startedAt?: number | undefined;
    outcome?: TurnOutcome | undefined;
    /** A restart, not the person, cut the turn short. */
    restarted?: boolean | undefined;
    summary?: TurnSummary | undefined;
  },
): { label: string; endedAt: number | undefined } | undefined {
  const { until, idle = 0, summary: turn } = options;
  const loaded = useItemsSelect(threadId, itemIds, summarizeWork, flatEqual);
  const from = turn?.startedAt ?? options.startedAt ?? loaded?.startedAt ?? 0;
  // Frozen: from the first step to the moment the stretch closed, whatever settles later.
  const to = turn?.endedAt ?? until ?? loaded?.endedAt ?? 0;
  const waited = useWaited(threadId, from, to);
  if (!loaded && !turn && options.outcome === undefined) return undefined;
  return {
    label: turnHeadLabel(options.outcome, options.restarted === true, to - from - waited - idle),
    endedAt: to || undefined,
  };
}
