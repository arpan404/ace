import { ForgePrSearch, type ForgePrList, type ForgePrRow } from "@ace/protocol";
import { prQuery, type PullsSearch, type RowGroup } from "./pulls-model.ts";

/*
 * "Ready to merge": every open pull request ranked by how close it is to merging, across the
 * whole repository rather than the pages already read. A row's tier comes from its own facts
 * (review decision, checks, conflicts, draft), so it lands in the right tier whichever search
 * found it. Searches only decide the order in which GitHub is asked: readiest first.
 */

export const tiers = [
  { id: "ready", label: "Ready" },
  { id: "checks", label: "Waiting on checks" },
  { id: "review", label: "Waiting on review" },
  { id: "changes", label: "Needs changes" },
  { id: "other", label: "Other" },
  { id: "drafts", label: "Drafts" },
] as const;
export type Tier = (typeof tiers)[number]["id"];

/**
 * How close one pull request is to merging, by its review decision and checks: the same rules,
 * in the same order, that count each tier on GitHub. Conflicts aren't searchable, so they only
 * move a pull request to the end of its tier.
 */
export function readinessTier(row: ForgePrRow): Tier {
  if (row.state === "draft") return "drafts";
  if (row.state !== "open") return "other";
  if (row.ci === "failure" || row.reviewDecision === "CHANGES_REQUESTED") return "changes";
  if (row.reviewDecision === "REVIEW_REQUIRED") return "review";
  if (row.ci === "pending") return "checks";
  // Approved, or a repository that requires no review, with checks green or none at all.
  if (
    (row.reviewDecision === "APPROVED" || row.reviewDecision === null) &&
    (row.ci === "success" || row.ci === "none")
  )
    return "ready";
  return "other";
}

/** Within a tier: mergeable before conflicting, then newest activity first. */
const within = (a: ForgePrRow, b: ForgePrRow) =>
  Number(!!a.conflicting) - Number(!!b.conflicting) || b.updatedAt.localeCompare(a.updatedAt);
const key = (row: ForgePrRow) =>
  `${row.ref.repository.owner}/${row.ref.repository.name}#${row.ref.number}`.toLowerCase();

/** Rows grouped by tier, readiest first; each PR once. */
export function rankByReadiness(rows: readonly ForgePrRow[]): RowGroup<ForgePrRow>[] {
  const seen = new Set<string>();
  const unique = rows.filter((row) => !seen.has(key(row)) && seen.add(key(row)));
  return tiers
    .map((tier) => ({
      id: tier.id,
      label: tier.label,
      rows: unique.filter((row) => readinessTier(row) === tier.id).toSorted(within),
    }))
    .filter((group) => group.rows.length > 0);
}

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
