import { z } from "zod";
import type { ForgeRepository } from "@ace/protocol/forge";
import { ForgePrSearch, type ForgeGroupCounting } from "@ace/protocol/forge-browser";
import { ForgeError } from "./errors.ts";
import { prSearchQuery } from "./github-browser.ts";
import { issueSearchQuery } from "./github-issues.ts";
import type { GhApi } from "./http.ts";

/*
 * How many pull requests or issues each group of a list holds, as GitHub's search counts them.
 * Groups are mutually exclusive: each excludes the qualifiers of the groups before it, so every
 * item is counted once, in its first group. The last group of a total is what the others left.
 */

/** One counted group: the searches whose counts add up to it, or what is left of the total. */
export type CountGroup =
  | { id: string; queries: string[]; /** Counted beside the total, not within it. */ apart?: true }
  | { id: string; rest: true };
export interface CountPlan {
  total: string;
  groups: CountGroup[];
}

const noBlockers = "-review:required -review:changes_requested";

/**
 * Readiness tiers in the order the list ranks them: changes requested or failing checks, review
 * still required, checks still running, ready (approved or no review required, checks green or
 * none), whatever is left; drafts are counted apart. `open` is the open non-draft search.
 */
export function readinessPlan(open: string, drafts: string): CountPlan {
  return {
    total: open,
    groups: [
      {
        id: "changes",
        queries: [
          `${open} review:changes_requested`,
          `${open} status:failure -review:changes_requested`,
        ],
      },
      { id: "review", queries: [`${open} review:required -status:failure`] },
      { id: "checks", queries: [`${open} status:pending ${noBlockers}`] },
      {
        id: "ready",
        queries: [
          `${open} status:success ${noBlockers}`,
          `${open} -status:success -status:failure -status:pending ${noBlockers}`,
        ],
      },
      { id: "other", rest: true },
      { id: "drafts", queries: [drafts], apart: true },
    ],
  };
}

/** Yours, then the ones asking for your review, then the rest. */
export function prPeoplePlan(search: string): CountPlan {
  return {
    total: search,
    groups: [
      { id: "authored", queries: [`${search} author:@me`] },
      { id: "reviewing", queries: [`${search} review-requested:@me -author:@me`] },
      { id: "others", rest: true },
    ],
  };
}

/** Assigned to you, then opened by you, then the rest. */
export function issuePeoplePlan(search: string): CountPlan {
  return {
    total: search,
    groups: [
      { id: "assigned", queries: [`${search} assignee:@me`] },
      { id: "created", queries: [`${search} author:@me -assignee:@me`] },
      { id: "others", rest: true },
    ],
  };
}

const Counts = z.looseObject({
  data: z.record(z.string(), z.looseObject({ issueCount: z.number().int().nonnegative() })),
});

/** Every search of `plan` as one aliased GraphQL document: one request for all the counts. */
export function countDocument(plan: CountPlan): string {
  const searches = [
    plan.total,
    ...plan.groups.flatMap((group) => ("queries" in group ? group.queries : [])),
  ];
  return `query { ${searches
    .map(
      (search, index) =>
        `c${index}: search(type: ISSUE, query: ${JSON.stringify(search)}, first: 1) { issueCount }`,
    )
    .join(" ")} }`;
}

/** Each group's count from the answer to `countDocument(plan)`. */
export function readCounts(plan: CountPlan, body: unknown): Record<string, number> {
  const parsed = Counts.safeParse(body);
  if (!parsed.success) throw new ForgeError("invalid_data");
  const count = (index: number) => {
    const value = parsed.data.data[`c${index}`];
    if (!value) throw new ForgeError("invalid_data");
    return value.issueCount;
  };
  const counts: Record<string, number> = {};
  let next = 1;
  let counted = 0;
  for (const group of plan.groups) {
    if (!("queries" in group)) continue;
    const sum = group.queries.reduce((total) => total + count(next++), 0);
    counts[group.id] = sum;
    if (!group.apart) counted += sum;
  }
  const total = count(0);
  for (const group of plan.groups)
    if ("rest" in group) counts[group.id] = Math.max(0, total - counted);
  return counts;
}

/** The searches counting `grouping` in `repository`, filters and all. */
export function groupPlan(repository: ForgeRepository, grouping: ForgeGroupCounting): CountPlan {
  if (grouping.by === "issue-people")
    return issuePeoplePlan(issueSearchQuery(repository, grouping.query));
  if (grouping.by === "pr-people") return prPeoplePlan(prSearchQuery(repository, grouping.query));
  // Tiers split open PRs from drafts themselves; every other filter of the list narrows each
  // tier (GitHub ands qualifiers, so a tier a filter rules out counts none).
  return readinessPlan(
    prSearchQuery(repository, ForgePrSearch.parse({ ...grouping.query, state: "open" })),
    prSearchQuery(repository, ForgePrSearch.parse({ ...grouping.query, state: "draft" })),
  );
}

/** Every group's total in one GraphQL request. */
export async function readGroupCounts(
  api: GhApi,
  repository: ForgeRepository,
  grouping: ForgeGroupCounting,
  signal: AbortSignal,
): Promise<Record<string, number>> {
  const plan = groupPlan(repository, grouping);
  const response = await api.request("graphql", signal, { query: countDocument(plan) });
  return readCounts(plan, response.body);
}
