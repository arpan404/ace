import type { ForgeRepository } from "@ace/protocol";
import { repositoryCapabilities } from "@ace/ui-core";
import { useDaemonQuery } from "./daemon-query.ts";
import { readForge } from "./forge-read.ts";
import { useProjectRepositoryLists } from "./project-repositories.ts";

/** Resolve declarations for controls whose data contains only a repository identity. */
export function useRepositoryCapabilities(
  project: string | undefined,
  repository: ForgeRepository | undefined,
) {
  const { lists, pending } = useProjectRepositoryLists(project ? [project] : []);
  const fallback = useDaemonQuery({
    queryKey: ["forge", project, "repository"],
    enabled: !!project && !repository && !lists.has(project) && !pending.has(project),
    retry: false,
    staleTime: 10 * 60_000,
    read: async (client, signal) => {
      if (!project) return null;
      const result = await readForge(
        client,
        { op: "forge.repository", workspaceId: project },
        signal,
      );
      if (result.resource !== "repository") throw new Error("No repository.");
      return result.value;
    },
  });
  const target = repository ?? (project ? lists.get(project)?.primary : undefined) ?? fallback.data;
  return target
    ? repositoryCapabilities(target, project ? (lists.get(project)?.repositories ?? []) : [])
    : undefined;
}
