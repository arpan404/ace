import type { ForgeRepository } from "@ace/protocol";
import { issueSources, reviewSources, type ReviewSource } from "@ace/ui-core";
import { useProjectRepositoryLists } from "@/lib/project-repositories.ts";

/** The reads a list sends for its projects, and what is known of their repositories. */
export interface ListSources {
  sources: ReviewSource[];
  /**
   * Every project's repositories were read, so totals may be summed. False while one is
   * still reading, and when one couldn't be read (that project reads its primary alone).
   */
  settled: boolean;
  /** Projects whose reads come from more than one repository. */
  several: ReadonlySet<string>;
  /** Projects whose repositories couldn't be read: their primary alone is listed. */
  unlisted: readonly string[];
  /** Each project's primary, once its repositories are read. */
  primary: ReadonlyMap<string, ForgeRepository>;
}

function useSources(projects: readonly string[], plan: typeof reviewSources): ListSources {
  const { lists, pending, failed } = useProjectRepositoryLists(projects);
  const sources = plan(projects, lists);
  const several = new Set(sources.filter((source) => source.shown).map((source) => source.project));
  const primary = new Map<string, ForgeRepository>();
  for (const [project, value] of lists) if (value.primary) primary.set(project, value.primary);
  return {
    sources,
    settled: pending.size === 0 && failed.size === 0,
    several,
    unlisted: projects.filter((project) => failed.has(project)),
    primary,
  };
}

/**
 * The pull request reads Code review sends for these projects: one per repository each reviews
 * (`reviewSources`). Until a project's repositories are known its primary is read alone, so
 * the first rows show at once.
 */
export function useReviewSources(projects: readonly string[]): ListSources {
  return useSources(projects, reviewSources);
}

/** The issue reads for these projects (`issueSources`), by the same rule. */
export function useIssueSources(projects: readonly string[]): ListSources {
  return useSources(projects, issueSources);
}
