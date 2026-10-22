import { useClient } from "@ace/client-react";
import { repositoryFromRemote } from "@ace/forge/detect";
import { useQuery } from "@tanstack/react-query";
import { useProjectMetadata } from "@/lib/projects.ts";

/** What a project's inspection says about its git remotes. */
type ProjectRemotes = {
  git: { remotes: readonly { name: string; fetchUrls: readonly string[] }[] } | null;
};

/** origin first, then upstream, then the rest: the remote a person most likely means. */
const rank = (name: string) => (name === "origin" ? 0 : name === "upstream" ? 1 : 2);

/**
 * The project's GitHub repository as "owner/name", read from its git remotes, for a GitHub
 * trigger to start from. Undefined when no remote points at GitHub; the person types one then.
 */
export function projectRepository(project: ProjectRemotes | undefined): string | undefined {
  const remotes = (project?.git?.remotes ?? []).toSorted((a, b) => rank(a.name) - rank(b.name));
  for (const remote of remotes)
    for (const url of remote.fetchUrls) {
      try {
        const repository = repositoryFromRemote(url);
        if (repository.forge === "github") return `${repository.owner}/${repository.name}`;
      } catch {
        // Not a GitHub remote (a local path, GitLab, another host): try the next one.
      }
    }
  return undefined;
}

/** The chosen project's GitHub repository, asked of the daemon once per project path. */
export function useProjectRepository(workspaceId: string): string | undefined {
  const client = useClient();
  const path = useProjectMetadata()(workspaceId)?.path;
  const query = useQuery({
    queryKey: ["automations", "project-repository", path],
    queryFn: async ({ signal }) => {
      const reply = await client.projects.inspect(path ?? "", { signal });
      return reply.result.kind === "inspection" ? (projectRepository(reply.result) ?? null) : null;
    },
    enabled: path !== undefined,
    staleTime: 5 * 60_000,
    retry: false,
  });
  return query.data ?? undefined;
}
