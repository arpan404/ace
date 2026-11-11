import { repositoryKey } from "@ace/forge/project-repositories";
import type { ForgeRepository, ProjectRepositories, ProjectRepositoryConfig } from "@ace/protocol";
import { defaultForgeHost, forgeDisplayName } from "./forge-hosts.ts";

/*
 * A project's repositories as clients use them (ADR 0120): which ones Code review lists, how a
 * repository is labelled, and the edits the project's settings make to its saved choices. Web
 * and the iPhone share these. Pure. Every push names the global remote name; the daemon picks
 * where the push before a new pull request goes.
 */

/** Repositories Code review lists for a project: visible and available, in the daemon's order. */
export function reviewRepositories(value: ProjectRepositories | undefined): ForgeRepository[] {
  return (value?.repositories ?? [])
    .filter((entry) => entry.visible && entry.available)
    .map((entry) => entry.repository);
}

/** "GitLab · acme/api", naming the host when it isn't the provider's public one. */
export function repositoryLabel(repository: ForgeRepository): string {
  const path = `${repository.owner}/${repository.name}`;
  const host =
    repository.host.toLowerCase() === defaultForgeHost(repository.forge)
      ? ""
      : `${repository.host}/`;
  return `${forgeDisplayName(repository.forge)} · ${host}${path}`;
}

const same = (a: ForgeRepository, b: ForgeRepository) => repositoryKey(a) === repositoryKey(b);
const without = (list: readonly ForgeRepository[], repository: ForgeRepository) =>
  list.filter((entry) => !same(entry, repository));

/** Choices with nothing chosen are no choices: the project goes back to its default rule. */
function settled(config: ProjectRepositoryConfig): ProjectRepositoryConfig | null {
  return config.added.length || config.hidden.length || config.primary ? config : null;
}

const start = (config: ProjectRepositoryConfig | null): ProjectRepositoryConfig =>
  config ?? { added: [], hidden: [], primary: null };

/** Stop using a repository. Hiding the primary also clears the primary choice. */
export function hideRepository(
  config: ProjectRepositoryConfig | null,
  repository: ForgeRepository,
): ProjectRepositoryConfig | null {
  const current = start(config);
  return settled({
    ...current,
    hidden: [...without(current.hidden, repository), repository],
    primary: current.primary && same(current.primary, repository) ? null : current.primary,
  });
}

export function showRepository(
  config: ProjectRepositoryConfig | null,
  repository: ForgeRepository,
): ProjectRepositoryConfig | null {
  const current = start(config);
  return settled({ ...current, hidden: without(current.hidden, repository) });
}

/** Open new pull requests on this repository. A hidden repository is shown again. */
export function makePrimary(
  config: ProjectRepositoryConfig | null,
  repository: ForgeRepository,
): ProjectRepositoryConfig | null {
  const current = start(config);
  return settled({ ...current, hidden: without(current.hidden, repository), primary: repository });
}

/** Add a repository by hand, after the others; adding one already added changes nothing. */
export function addRepository(
  config: ProjectRepositoryConfig | null,
  repository: ForgeRepository,
): ProjectRepositoryConfig | null {
  const current = start(config);
  return settled({
    ...current,
    added: current.added.some((entry) => same(entry, repository))
      ? current.added
      : [...current.added, repository],
    hidden: without(current.hidden, repository),
  });
}

/** Remove a repository added by hand, and any choice about it. */
export function removeRepository(
  config: ProjectRepositoryConfig | null,
  repository: ForgeRepository,
): ProjectRepositoryConfig | null {
  const current = start(config);
  return settled({
    added: without(current.added, repository),
    hidden: without(current.hidden, repository),
    primary: current.primary && same(current.primary, repository) ? null : current.primary,
  });
}

/** One edit of a project's choices: the edit functions above, bound to their repository. */
export type RepositoryEdit = (
  config: ProjectRepositoryConfig | null,
) => ProjectRepositoryConfig | null;

/**
 * Save one edit of a project's choices, applied to the choices it was read from and naming them
 * as `expected`. When another device saved meanwhile (`repositories_changed`) the choices are
 * read again and the same edit is applied to them, once; a second conflict is the answer.
 */
export async function saveRepositoryEdit<Outcome>(
  io: {
    /** The project's saved choices now (`forge.repositories`' `config`). */
    read: () => Promise<ProjectRepositoryConfig | null>;
    save: (
      repositories: ProjectRepositoryConfig | null,
      expected: ProjectRepositoryConfig | null,
    ) => Promise<Outcome>;
    /** The save was refused with `repositories_changed`. */
    changed: (outcome: Outcome) => boolean;
  },
  edit: RepositoryEdit,
  from: ProjectRepositoryConfig | null,
): Promise<Outcome> {
  const first = await io.save(edit(from), from);
  if (!io.changed(first)) return first;
  const current = await io.read();
  return io.save(edit(current), current);
}
