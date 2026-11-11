import type { ForgeRepository } from "@ace/protocol";
import { useClient, useConnectionState } from "@ace/client-react";
import { useQueries } from "@tanstack/react-query";
import { inboxRepositoriesOf, type InboxProjectRepositories } from "./inbox-model.ts";
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
 * Each project's repositories for telling notifications apart by project (ADR 0116): its primary,
 * and, for a project with saved choices, its other visible, available repositories (from
 * `forge.repositories`). A project with
 * no saved choices tags rows with its primary alone, as before; so does one whose repositories
 * can't be listed (an older daemon, a failed read).
 */
export function useInboxRepositories(projects: readonly string[]): {
  repositories: ReadonlyMap<string, InboxProjectRepositories>;
  primary: ReadonlyMap<string, ForgeRepository>;
} {
  const { lists, pending } = useProjectRepositoryLists(projects);
  const missing = projects.filter((project) => !lists.has(project) && !pending.has(project));
  const fallback = useProjectRepositories(missing);
  const repositories = new Map<string, InboxProjectRepositories>();
  const primary = new Map<string, ForgeRepository>();
  for (const project of projects) {
    const value = inboxRepositoriesOf(lists.get(project), fallback.get(project));
    if (value.primary) primary.set(project, value.primary);
    repositories.set(project, value);
  }
  return { repositories, primary };
}
