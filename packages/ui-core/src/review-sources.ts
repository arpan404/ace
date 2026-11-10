import { repositoryKey } from "@ace/forge/project-repositories";
import type { ForgeRepository, ProjectRepositories } from "@ace/protocol";
import { reviewRepositories } from "./project-repositories.ts";

/*
 * Which list reads Code review sends for a set of projects (ADR 0116): one per repository each
 * project reviews. Pure; web and the iPhone share it.
 */

/** One list read: a project, and the repository it names when that isn't the project's primary. */
export interface ReviewSource {
  project: string;
  /** Sent as the read's `repository`; absent reads the project's primary, as before. */
  repository?: ForgeRepository | undefined;
  /** The repository this read lists, when the project lists more than one. */
  shown?: ForgeRepository | undefined;
}

/**
 * Each project's reads, in the projects' order then the daemon's repository order. A project
 * whose repositories aren't known (an older daemon, a failed read) is read as before, through
 * its primary. One whose choices hide every repository lists nothing. The primary is read
 * without naming it, so its cached pages and every older reader stay the same read.
 */
export function reviewSources(
  projects: readonly string[],
  lists: ReadonlyMap<string, ProjectRepositories>,
): ReviewSource[] {
  return projects.flatMap((project): ReviewSource[] => {
    const value = lists.get(project);
    if (!value) return [{ project }];
    const repositories = reviewRepositories(value);
    if (!repositories.length) return value.config ? [] : [{ project }];
    const primary = value.primary && repositoryKey(value.primary);
    const several = repositories.length > 1;
    return repositories.map((repository) => ({
      project,
      ...(repositoryKey(repository) === primary ? {} : { repository }),
      ...(several ? { shown: repository } : {}),
    }));
  });
}

/** A read's id: the project alone for its primary, else the project and the repository. */
export function reviewSourceId(source: Pick<ReviewSource, "project" | "repository">): string {
  return source.repository
    ? `${source.project}\n${repositoryKey(source.repository)}`
    : source.project;
}
