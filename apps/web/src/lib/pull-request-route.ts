import type { ForgeRepository } from "@ace/protocol";

/*
 * The address of ace's page for one pull request: `/pulls/<project>/<number>`, with `repo` when
 * the PR lives in a repository other than the project's own.
 */

/** `github.com/acme/ace`: a repository in an address, for a PR outside the project's own. */
export function repositoryParam(repository: ForgeRepository): string {
  return `${repository.host}/${repository.owner}/${repository.name}`;
}

export function repositoryFromParam(value: string | undefined): ForgeRepository | undefined {
  const parts = value?.split("/");
  if (!parts || parts.length !== 3 || parts.some((part) => !part)) return undefined;
  const [host = "", owner = "", name = ""] = parts;
  return { forge: "github", host, owner, name };
}
