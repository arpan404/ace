import type { ThreadKey, ThreadReader } from "@ace/client";
import { useThread, useThreadMeta } from "@ace/client-react";
import { sameActivity, turnActivity, type TurnActivity } from "@ace/ui-core";
import { useCallback, useMemo } from "react";
import { useStopping } from "../composer/stop-state.ts";

const off: readonly ThreadKey[] = [];

/**
 * The turn's one live line (`turnActivity`). The transcript's bottom work log and the live
 * footer both read it, so they never disagree. `enabled: false` subscribes to nothing.
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
    (reader: ThreadReader) =>
      enabled ? turnActivity(reader, rootId, { threadStatus: status, stopping }) : undefined,
    [enabled, rootId, status, stopping],
  );
  return useThread(threadId, keys, read, sameActivity);
}
