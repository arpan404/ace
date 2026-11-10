import type { ForgeRepository } from "@ace/protocol";
import { useClient, useConnectionState } from "@ace/client-react";
import { useQueries } from "@tanstack/react-query";
import { reviewRepositories } from "@ace/ui-core";
import { readForge } from "@/lib/forge-read.ts";
import { useProjectRepositoryLists } from "@/lib/project-repositories.ts";

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

/**
 * Every repository each project uses (ADR 0116) and its primary, for telling notifications apart
 * by project: the visible ones from `forge.repositories`, plus those the inbox's own read
 * names for its project. A daemon that can't list them gives each project its primary alone.
 */
export function useInboxRepositories(
  projects: readonly string[],
  own?: { project: string | undefined; repositories: readonly ForgeRepository[] | undefined },
): {
  repositories: ReadonlyMap<string, readonly ForgeRepository[]>;
  primary: ReadonlyMap<string, ForgeRepository>;
} {
  const { lists, pending } = useProjectRepositoryLists(projects);
  const missing = projects.filter((project) => !lists.has(project) && !pending.has(project));
  const fallback = useProjectRepositories(missing);
  const repositories = new Map<string, readonly ForgeRepository[]>();
  const primary = new Map<string, ForgeRepository>();
  for (const project of projects) {
    const value = lists.get(project);
    const main = value ? (value.primary ?? undefined) : fallback.get(project);
    if (main) primary.set(project, main);
    const listed = value ? reviewRepositories(value) : main ? [main] : [];
    const extra = own?.project === project ? (own.repositories ?? []) : [];
    repositories.set(project, [...listed, ...extra]);
  }
  return { repositories, primary };
}
