import type { ThreadReader } from "@ace/client";
import { useThread } from "@ace/client-react";
import {
  activityText,
  formatElapsed,
  humanWaits,
  summarizeWork,
  workCounts,
  workedFor,
  type WaitSpan,
  type WorkLogHeadline,
} from "@ace/ui-core";
import { useTicker } from "../lib/clock.ts";
import { flatEqual, useItemsSelect } from "../lib/use-items.ts";
import { useTurnActivity } from "../transcript/use-turn-activity.ts";
import { useStepDisplay } from "./use-step-display.ts";

const readWaits = (reader: ThreadReader) => humanWaits(reader);
const sameWaits = (a: readonly WaitSpan[], b: readonly WaitSpan[]) =>
  a.length === b.length && a.every((span, index) => flatEqual(span, b[index] ?? {}));

/**
 * A work log's headline. At rest it reads "Worked for 4m 12s", the time its steps took less any
 * wait on the person, and never ticks: a step still unsettled shows that on its own row. Only
 * `live`, the bottom log of a turn the agent is working on, carries the turn's live line
 * ("Working for …", ticking), the same line the footer would otherwise show.
 */
export function useWorkLog(
  threadId: string,
  itemIds: readonly string[],
  live = false,
): WorkLogHeadline | undefined {
  const summary = useItemsSelect(threadId, itemIds, summarizeWork, flatEqual);
  const waits = useThread(threadId, ["interactions"], readWaits, sameWaits);
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
  const worked = workedFor(waits ?? [], summary.startedAt, summary.endedAt);
  return {
    label: `Worked for ${formatElapsed(Math.max(1000, worked))}`,
    counts,
    running: false,
    current: undefined,
    awaiting: summary.awaiting,
  };
}

/** One work-log step: the item for its detail and how its row reads (WP2's step display). */
export const useToolStep = useStepDisplay;
