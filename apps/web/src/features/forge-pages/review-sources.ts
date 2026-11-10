import { reviewSources, type ReviewSource } from "@ace/ui-core";
import { useProjectRepositoryLists } from "@/lib/project-repositories.ts";

/**
 * The list reads Code review sends for these projects: one per repository each reviews
 * (`reviewSources`). Until a project's repositories are known its primary is read alone, so
 * the first rows show at once; `settled` says every project's repositories are in, so totals
 * may be summed.
 */
export function useReviewSources(projects: readonly string[]): {
  sources: ReviewSource[];
  settled: boolean;
  /** Projects whose reviews come from more than one repository. */
  several: ReadonlySet<string>;
} {
  const { lists, pending } = useProjectRepositoryLists(projects);
  const sources = reviewSources(projects, lists);
  const several = new Set(sources.filter((source) => source.shown).map((source) => source.project));
  return { sources, settled: pending.size === 0, several };
}
