import { z } from "zod";
import type { ForgePrRow } from "@ace/protocol/forge-browser";
import type { ForgeRepository } from "@ace/protocol/forge";
import { ForgeError } from "./errors.ts";
import { avatars, logins } from "./github-row-facts.ts";

const total = z.looseObject({ totalCount: z.number().int().nonnegative() });
const count = z.number().int().nonnegative().optional().catch(undefined);
const name = z.string().max(65_536).optional().catch(undefined);
export const PrIndicator = z.looseObject({
  comments: total,
  reviews: total,
  statusCheckRollup: z.looseObject({ state: z.string() }).nullable(),
  reviewDecision: z.string().max(100).nullable().optional().catch(undefined),
  headRefName: name,
  baseRefName: name,
  additions: count,
  deletions: count,
  mergeable: z.string().max(100).optional().catch(undefined),
  reviewRequests: z
    .looseObject({
      nodes: z.array(z.looseObject({ requestedReviewer: z.unknown().nullable() }).nullable()),
    })
    .optional()
    .catch(undefined),
});
const Indicators = z.looseObject({
  data: z.looseObject({ repository: z.record(z.string(), PrIndicator.nullable()).optional() }),
});
/** One alias per listed PR: its counts, checks, review decision, branches, size and reviewers. */
export function prIndicatorFields(repository: ForgeRepository, numbers: readonly number[]): string {
  if (!numbers.length) return "";
  const fields = numbers.map(
    (number, i) =>
      `p${i}: pullRequest(number:${number}) { comments { totalCount } reviews { totalCount } statusCheckRollup { state } reviewDecision headRefName baseRefName additions deletions mergeable reviewRequests(first: 10) { nodes { requestedReviewer { ... on User { login avatarUrl } } } } }`,
  );
  return `repository(owner:${JSON.stringify(repository.owner)}, name:${JSON.stringify(repository.name)}) { ${fields.join(" ")} }`;
}
const Decision = z.enum(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"]);

/** What a PR's GraphQL fields add to its row; a field GitHub left out stays off the row. */
export function prIndicator(row: z.infer<typeof PrIndicator>): Partial<ForgePrRow> {
  const state = row.statusCheckRollup?.state;
  const requested = (row.reviewRequests?.nodes ?? []).map((node) => node?.requestedReviewer);
  const reviewers = logins(requested);
  const decision = Decision.safeParse(row.reviewDecision);
  return {
    raw: row,
    commentCount: row.comments.totalCount,
    reviewCount: row.reviews.totalCount,
    ci:
      row.statusCheckRollup === null
        ? "none"
        : state === "SUCCESS"
          ? "success"
          : state === "FAILURE" || state === "ERROR"
            ? "failure"
            : state === "PENDING" || state === "EXPECTED"
              ? "pending"
              : "unknown",
    ...(row.reviewDecision === null
      ? { reviewDecision: null }
      : decision.success
        ? { reviewDecision: decision.data }
        : {}),
    ...(row.headRefName ? { headBranch: row.headRefName } : {}),
    ...(row.baseRefName ? { baseBranch: row.baseRefName } : {}),
    ...(row.additions === undefined ? {} : { additions: row.additions }),
    ...(row.deletions === undefined ? {} : { deletions: row.deletions }),
    ...(row.mergeable ? { conflicting: row.mergeable === "CONFLICTING" } : {}),
    ...(row.reviewRequests ? { reviewers, avatars: avatars(requested) } : {}),
  };
}
export function prIndicators(body: unknown): Record<string, Partial<ForgePrRow>> {
  const parsed = Indicators.safeParse(body);
  if (!parsed.success) throw new ForgeError("invalid_data");
  const rows = parsed.data.data.repository ?? {};
  return Object.fromEntries(
    Object.entries(rows).flatMap(([key, row]) => (row ? [[key, prIndicator(row)]] : [])),
  );
}
/** The signed-in account a GraphQL answer named in `viewer { login }`, if it did. */
export function viewerLogin(body: unknown): string | undefined {
  const parsed = z
    .looseObject({ data: z.looseObject({ viewer: z.looseObject({ login: z.string() }) }) })
    .safeParse(body);
  return parsed.success ? parsed.data.data.viewer.login.slice(0, 100) : undefined;
}
