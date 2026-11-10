import { repositoryKey } from "@ace/forge/project-repositories";
import { can } from "./forge-capability.ts";
import type { ForgeRepository, ProjectRepositories } from "@ace/protocol";

/*
 * Which list reads Code review sends for a set of projects (ADR 0116): one per repository each
 * project reviews, for pull requests and for issues. Pure; web and the iPhone share it.
 */

/** One list read: a project, and the repository it names when that isn't the project's primary. */
export interface ReviewSource {
  project: string;
  /** Sent as the read's `repository`; absent reads the project's primary, as before. */
  repository?: ForgeRepository | undefined;
  /** The repository this read lists, when the project lists more than one. */
  shown?: ForgeRepository | undefined;
}

function sourcesOf(
  projects: readonly string[],
  lists: ReadonlyMap<string, ProjectRepositories>,
  readable: (entry: ProjectRepositories["repositories"][number]) => boolean,
): ReviewSource[] {
  return projects.flatMap((project): ReviewSource[] => {
    const value = lists.get(project);
    if (!value) return [{ project }];
    const repositories = value.repositories
      .filter((entry) => entry.visible && entry.available && readable(entry))
      .map((entry) => entry.repository);
    if (!repositories.length) return [];
    const primary = value.primary && repositoryKey(value.primary);
    const several = repositories.length > 1;
    return repositories.map((repository) => {
      const source: ReviewSource = { project };
      if (repositoryKey(repository) !== primary) source.repository = repository;
      if (several) source.shown = repository;
      return source;
    });
  });
}

/**
 * Each project's pull request reads, in the projects' order then the daemon's repository order:
 * one per visible, available repository. A project whose repositories aren't known (an older
 * daemon, a failed read) is read as before, through its primary. One whose choices hide every
 * repository lists nothing. The primary is read without naming it, so its cached pages and
 * every older reader stay the same read.
 */
export function reviewSources(
  projects: readonly string[],
  lists: ReadonlyMap<string, ProjectRepositories>,
): ReviewSource[] {
  return sourcesOf(projects, lists, (entry) => can(entry, "reviews.read"));
}

/**
 * Each project's issue reads, by the same rule as `reviewSources`, from the repositories whose
 * capabilities include issues.read. Older daemons keep the legacy GitHub-only issue list.
 */
export function issueSources(
  projects: readonly string[],
  lists: ReadonlyMap<string, ProjectRepositories>,
): ReviewSource[] {
  return sourcesOf(projects, lists, (entry) => can(entry, "issues.read"));
}

/** A read's id: the project alone for its primary, else the project and the repository. */
export function reviewSourceId(source: Pick<ReviewSource, "project" | "repository">): string {
  return source.repository
    ? `${source.project}\n${repositoryKey(source.repository)}`
    : source.project;
}
