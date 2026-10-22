import { ForgePrSearch, type ForgePrList } from "@ace/protocol";
import { prQuery, type PullsSearch } from "./pulls-model.ts";

/*
 * "Ready to merge": every open pull request, read across the whole repository rather than the
 * pages already read, readiest first, so the ones closest to merging show without paging. The
 * list then groups them by what each needs next (`next-steps.ts`).
 */

/**
 * The searches to page through, readiest first, for the list's other filters. The last two
 * (every open PR, then drafts) catch whatever the qualified searches can't express, such as a
 * repository that requires no review. A filter on review, checks or drafts already narrows the
 * list, so then the plain search alone is read and ranked.
 */
export function readinessQueries(search: PullsSearch): ForgePrSearch[] {
  const base = prQuery({ ...search, state: "open", draft: "hide" }, 1);
  const narrowed = search.review || search.checks || search.draft;
  if (narrowed || (search.state ?? "open") !== "open") return [prQuery(search, 1)];
  const tier = (patch: Partial<ForgePrSearch>) => ForgePrSearch.parse({ ...base, ...patch });
  return [
    tier({ review: "approved", ci: "success" }),
    tier({ review: "approved", ci: "pending" }),
    tier({ review: "required" }),
    tier({ review: "changes_requested" }),
    tier({ ci: "failure" }),
    base,
    tier({ state: "draft" }),
  ];
}

/** One page read for the ranking: which search, and which of its pages. */
export interface Step {
  query: number;
  page: number;
}

/**
 * What to read after `steps`, given the answers so far: the next page of the current search,
 * else the first page of the next search; none once every search is exhausted.
 */
export function nextStep(
  steps: readonly Step[],
  answers: readonly (ForgePrList | undefined)[],
  queries: number,
): Step | undefined {
  const last = steps[steps.length - 1];
  if (!last) return queries > 0 ? { query: 0, page: 1 } : undefined;
  const answer = answers[steps.length - 1];
  if (!answer) return undefined;
  if (answer.nextPage !== undefined) return { query: last.query, page: answer.nextPage };
  return last.query + 1 < queries ? { query: last.query + 1, page: 1 } : undefined;
}
