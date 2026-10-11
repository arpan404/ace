import type { ThreadSource } from "@ace/client";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

/** Refresh observed summaries at most once per burst; unobserved blocks stay cheap and stale. */
export function useTurnRefresh(live: ThreadSource | undefined, threadId: string): void {
  const cache = useQueryClient();
  useEffect(() => {
    if (!live) return;
    const revision = live.select(["cursor"], (reader) => reader.cursor);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = revision.subscribe(() => {
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        void cache.invalidateQueries({
          queryKey: ["thread-turns", threadId],
          refetchType: "active",
        });
      }, 200);
    });
    return () => {
      stop();
      clearTimeout(timer);
    };
  }, [live, threadId, cache]);
}
