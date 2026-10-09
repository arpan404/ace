import { useDaemonSetting } from "./daemon-setting.ts";
import { useDaemonQuery } from "@/lib/daemon-query.ts";

/** One cached identity for every place that names the connected machine. */
export function useHostIdentity() {
  const [displayName] = useDaemonSetting("host.displayName");
  const [icon] = useDaemonSetting("host.icon");
  return useDaemonQuery({
    queryKey: ["host", "identity", displayName, icon],
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    read: async (client, signal) =>
      (await client.request({ type: "host.identity" }, { signal })).identity,
  }).data;
}
