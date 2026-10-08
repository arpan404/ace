import { useDaemonSetting } from "./daemon-setting.ts";
import { useDaemonQuery } from "@/lib/daemon-query.ts";

/** One cached identity for every place that names the connected machine. */
export function useHostIdentity() {
  const [displayName] = useDaemonSetting("host.displayName");
  return useDaemonQuery({
    queryKey: ["host", "identity", displayName],
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    read: async (client, signal) =>
      (await client.request({ type: "host.identity" }, { signal })).identity,
  }).data;
}

export function useHostName(): string | undefined {
  return useHostIdentity()?.displayName;
}

/** Saved thread names may be stale; another machine keeps its own name. */
export function useMachineName(machine: { host: string; name: string } | undefined) {
  const host = useHostIdentity();
  if (machine && machine.host !== host?.hostId) return machine.name;
  return host?.displayName ?? machine?.name;
}
