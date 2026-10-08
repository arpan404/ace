import { useDaemonQuery } from "@/lib/daemon-query.ts";

/**
 * The name of the machine this window's daemon runs on ("This Mac", "build-box"), as the
 * daemon gives it, for where a new thread will run. Undefined until the daemon has said.
 */
export function useHostName(): string | undefined {
  return useDaemonQuery({
    queryKey: ["host", "identity", "name"],
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    read: async (client, signal) =>
      (await client.request({ type: "host.identity" }, { signal })).identity.displayName,
  }).data;
}
