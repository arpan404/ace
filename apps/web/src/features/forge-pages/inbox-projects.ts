import type { ForgeRepository } from "@ace/protocol";
import { useClient, useConnectionState } from "@ace/client-react";
import { useQueries } from "@tanstack/react-query";
import { readForge } from "@/lib/forge-read.ts";

/**
 * Each project's repository, read once from its checkout's remote (no request to GitHub), so
 * account-wide notifications can be told apart by project. A project without a GitHub remote
 * is left out.
 */
export function useProjectRepositories(
  projects: readonly string[],
): ReadonlyMap<string, ForgeRepository> {
  const client = useClient();
  const ready = useConnectionState() === "ready";
  const results = useQueries({
    queries: projects.map((project) => ({
      queryKey: ["forge", project, "repository"],
      queryFn: async ({ signal }: { signal: AbortSignal }) => {
        const value = await readForge(
          client,
          { op: "forge.repository", workspaceId: project },
          signal,
        );
        if (value.resource !== "repository") throw new Error("No repository.");
        return value.value;
      },
      enabled: ready,
      staleTime: 10 * 60_000,
      gcTime: 60 * 60_000,
      retry: false,
      meta: { daemonClient: client },
    })),
  });
  const found = new Map<string, ForgeRepository>();
  results.forEach((result, index) => {
    const project = projects[index];
    if (project && result.data) found.set(project, result.data);
  });
  return found;
}
