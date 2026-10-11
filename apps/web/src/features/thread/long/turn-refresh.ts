import type { ThreadSource } from "@ace/client";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

/** Coalesce revisions, preserving slower reads and changes received while they are in flight. */
export function useTurnRefresh(live: ThreadSource | undefined, threadId: string): void {
  const cache = useQueryClient();
  useEffect(() => {
    if (!live) return;
    const revision = live.select(["cursor"], (reader) => reader.cursor);
    const queries = { queryKey: ["thread-turns", threadId] };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let dirty = false;
    let reading = false;
    let retired = false;
    const settled = () => {
      reading = false;
      if (dirty) schedule();
    };
    const schedule = () => {
      if (retired || reading || timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        // An existing read may have captured its snapshot before this revision.
        dirty = cache.isFetching({ ...queries, type: "active" }) > 0;
        reading = true;
        void cache
          .invalidateQueries({ ...queries, refetchType: "active" }, { cancelRefetch: false })
          .then(settled, settled);
      }, 200);
    };
    const stop = revision.subscribe(() => {
      dirty = true;
      schedule();
    });
    return () => {
      retired = true;
      stop();
      clearTimeout(timer);
    };
  }, [live, threadId, cache]);
}
