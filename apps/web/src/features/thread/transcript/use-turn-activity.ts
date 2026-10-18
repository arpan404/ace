import type { ThreadKey, ThreadReader } from "@ace/client";
import { useThreadMeta, useThreadUnconfirmed } from "@ace/client-react";
import { readTurnActivity, sameActivity, type TurnActivity } from "@ace/ui-core";
import { useCallback, useMemo } from "react";
import { pauseLabel, providerNames } from "@ace/ui-core";
import { useLiveConnection } from "@/lib/live-connection.ts";
import { useStopping } from "../composer/stop-state.ts";
import { useWatched, type Watched } from "@/lib/use-watched.ts";

import { useStepLabels } from "../items/step-labels.ts";

const off: readonly ThreadKey[] = [];
/** The line while the thread is a copy the daemon hasn't confirmed: neither working nor done. */
const syncingLine: TurnActivity = {
  label: "Syncing…",
  tone: "held",
  elapsedFrom: undefined,
  current: undefined,
};
const nothing: Watched<TurnActivity | undefined> = { value: undefined, watch: [] };

/**
 * The turn's one live line (`turnActivity`). The transcript's bottom work log and the live
 * footer both read it, so they never disagree. Besides the thread's membership keys it follows
 * the step in flight and the agents or tasks it names, so an update to any of them shows.
 * `enabled: false` subscribes to nothing. While the thread shows a copy the daemon hasn't
 * confirmed (read back from disk), the line says "Syncing…" whatever that copy says: a saved
 * "done" may be working again, so the transcript never reads as at rest until it is confirmed.
 */
export function useTurnActivity(threadId: string, enabled = true): TurnActivity | undefined {
  const live = useLiveConnection();
  const unconfirmed = useThreadUnconfirmed(enabled ? threadId : undefined);
  const labels = useStepLabels();
  const meta = useThreadMeta(threadId);
  const rootId = meta?.rootAgentId ?? "";
  const status = meta?.status;
  const keys = useMemo<readonly ThreadKey[]>(
    () =>
      enabled
        ? ["order", "agents", "tasks", "queue", "interactions", "thread", `agent:${rootId}`]
        : off,
    [enabled, rootId],
  );
  // A Stop on its way reads "Stopping…" until the turn ends (SY-8, the composer's Stop).
  const stopping = useStopping(enabled ? threadId : undefined);
  const read = useCallback(
    (reader: ThreadReader): Watched<TurnActivity | undefined> => {
      if (!enabled) return nothing;
      const reading = readTurnActivity(reader, rootId, { threadStatus: status, stopping, labels });
      return { value: reading.activity, watch: reading.watch };
    },
    [enabled, rootId, status, stopping, labels],
  );
  const activity = useWatched(threadId, keys, read, sameActivity);
  if (unconfirmed) return syncingLine;
  return activity && live.staleLabel
    ? { label: live.staleLabel, tone: "held", elapsedFrom: undefined, current: undefined }
    : activity?.tone === "paused"
      ? {
          ...activity,
          label: pauseLabel(meta ? providerNames[meta.provider] : undefined, undefined),
        }
      : activity;
}
