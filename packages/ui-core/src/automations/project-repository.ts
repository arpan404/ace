import { repositoryFromRemote } from "@ace/forge/detect";

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
