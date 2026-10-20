import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useDaemonSetting } from "./daemon-setting.ts";
import { useDaemonQuery } from "@/lib/daemon-query.ts";

export const hostIdentityKey = ["host", "identity"] as const;

/** The name and icon each cache last read the identity under. */
const namedAs = new WeakMap<QueryClient, string>();

/**
 * One cached identity for every place that names the connected machine. Its key stays the same
 * while the name and icon settings load (a key that changed then would drop the identity and
 * show New thread's skeleton twice); a later rename or new icon asks for it again.
 */
export function useHostIdentity() {
  const [displayName] = useDaemonSetting("host.displayName");
  const [icon] = useDaemonSetting("host.icon");
  const queries = useQueryClient();
  const named = JSON.stringify([displayName ?? null, icon ?? null]);
  const loaded = displayName !== undefined || icon !== undefined;
  useEffect(() => {
    if (!loaded) return;
    const before = namedAs.get(queries);
    namedAs.set(queries, named);
    if (before !== undefined && before !== named)
      void queries.invalidateQueries({ queryKey: hostIdentityKey, exact: true });
  }, [queries, named, loaded]);
  return useDaemonQuery({
    queryKey: hostIdentityKey,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    read: async (client, signal) =>
      (await client.request({ type: "host.identity" }, { signal })).identity,
  }).data;
}
