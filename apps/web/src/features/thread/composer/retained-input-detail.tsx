import type { ThreadReader } from "@ace/client";
import { useCallback } from "react";
import { useWatched, type Watched } from "@/lib/use-watched.ts";

const keys = ["order", "queue"] as const;
const none: Watched<string | undefined> = { value: undefined, watch: [] };

/**
 * The technical reason a kept message wasn't sent, from the daemon's notice for it. Retries
 * update the same persisted notice, so this follows the latest attempt.
 */
export function useRetainedInputDetail(
  threadId: string,
  commandId: string | undefined,
): string | undefined {
  const read = useCallback(
    (reader: ThreadReader): Watched<string | undefined> => {
      if (!commandId) return none;
      for (let at = reader.order.length - 1; at >= 0; at--) {
        const item = reader.item(reader.order[at] ?? "");
        if (item?.type === "notice" && item.code === "input_queued" && item.commandId === commandId)
          return { value: item.detail, watch: [`item:${item.id}`] };
      }
      return none;
    },
    [commandId],
  );
  return useWatched(threadId, keys, read, Object.is);
}
