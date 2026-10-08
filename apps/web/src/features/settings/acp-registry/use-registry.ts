import { useClient } from "@ace/client-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { readRegistry, refreshRegistry } from "./registry-data.ts";

export const registryKey = ["acp-registry"] as const;

/** A list read this recently isn't downloaded again just because the browser opened. */
const revalidateAfterMs = 10 * 60_000;

/**
 * The registry, stale-while-revalidate: the daemon's cached index shows at once, and opening
 * the browser downloads it again in the background when it's stale or older than ten minutes.
 * `now` is the browser's clock, injected by the caller.
 */
export function useRegistry(now: number) {
  const client = useClient();
  const queryClient = useQueryClient();
  const list = useDaemonQuery({ queryKey: registryKey, read: readRegistry });
  const refresh = useMutation({
    mutationFn: () => refreshRegistry(client),
    onSettled: () => queryClient.invalidateQueries({ queryKey: registryKey }),
  });
  const revalidated = useRef(false);
  const data = list.data;
  useEffect(() => {
    if (!data || revalidated.current) return;
    revalidated.current = true;
    if (data.stale || data.fetchedAt === undefined || now - data.fetchedAt > revalidateAfterMs)
      refresh.mutate();
  }, [data, now, refresh]);
  return { list, refresh };
}
