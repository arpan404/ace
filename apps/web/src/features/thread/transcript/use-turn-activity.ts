import type { ThreadKey, ThreadReader } from "@ace/client";
import { useThreadMeta } from "@ace/client-react";
import { readTurnActivity, sameActivity, type TurnActivity } from "@ace/ui-core";
import { useCallback, useMemo } from "react";
import { useStopping } from "../composer/stop-state.ts";
import { useWatched, type Watched } from "./use-watched.ts";

const off: readonly ThreadKey[] = [];
const nothing: Watched<TurnActivity | undefined> = { value: undefined, watch: [] };

/**
 * The turn's one live line (`turnActivity`). The transcript's bottom work log and the live
 * footer both read it, so they never disagree. Besides the thread's membership keys it follows
 * the step in flight and the agents or tasks it names, so an update to any of them shows.
 * `enabled: false` subscribes to nothing.
 */
export function useTurnActivity(threadId: string, enabled = true): TurnActivity | undefined {
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
      const reading = readTurnActivity(reader, rootId, { threadStatus: status, stopping });
      return { value: reading.activity, watch: reading.watch };
    },
    [enabled, rootId, status, stopping],
  );
  return useWatched(threadId, keys, read, sameActivity);
}
