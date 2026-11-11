import { spadeRoster, type SpadeAgent } from "@ace/ui-core/spade-chat";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { readAgents } from "./spade-api.ts";

export const agentsKey = ["spade", "agents"] as const;

/**
 * This machine's Spade and bots, Spade first. Spade has no stream for its roster, so it is read
 * again every few seconds while Spade runs, faster while any agent works or waits, so a reply
 * that ends elsewhere never leaves its row reading as working.
 */
export function useSpadeAgents(ready: boolean) {
  return useDaemonQuery<SpadeAgent[]>({
    queryKey: agentsKey,
    read: async (client, signal) => spadeRoster(await readAgents(client, { signal })),
    enabled: ready,
    refetchInterval: (query) =>
      query.state.data?.some((agent) => agent.state !== "idle") ? 2_000 : 10_000,
  });
}
