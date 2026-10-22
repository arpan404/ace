import type { ForgeRepository } from "@ace/protocol";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { keptForgeMs } from "@/lib/query-persistence.ts";
import { readForge } from "@/lib/forge-read.ts";

/**
 * What a pull request of `repository` may be given: labels, assignable people and open
 * milestones. Read when `enabled`, kept a few minutes: these change rarely.
 */
export function useRepoPrOptions(
  workspaceId: string,
  repository: ForgeRepository | undefined,
  enabled: boolean,
) {
  return useDaemonQuery({
    queryKey: ["forge", workspaceId, repository ?? "new-pr", "pr-options"],
    enabled,
    retry: false,
    staleTime: 5 * 60_000,
    gcTime: keptForgeMs,
    read: async (reader, signal) => {
      const result = await readForge(
        reader,
        { op: "forge.repo.pr-options", workspaceId, ...(repository ? { repository } : {}) },
        signal,
      );
      if (result.resource !== "repoPrOptions") throw new Error("No repository options returned.");
      return result.value;
    },
  });
}
