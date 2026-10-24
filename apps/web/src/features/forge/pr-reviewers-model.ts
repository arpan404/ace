import type { ForgeLatestReview, ForgePrReviewers } from "@ace/protocol";
import type { ReviewOutcome } from "@ace/ui-core";

/** One reviewer as the Reviewers list shows them: a person or a team, and what they can be asked. */
export interface ReviewerRow {
  key: string;
  kind: "user" | "team";
  /** A login, or a team's slug as requests name it. */
  name: string;
  /** What the row says: the login, or the team's name. */
  label: string;
  avatarUrl?: string | undefined;
  /** Asked and not answered yet (again, after a re-request). */
  requested: boolean;
  review?: ForgeLatestReview | undefined;
  /** Ask again someone who already reviewed. */
  canRerequest: boolean;
  /** Withdraw a request not answered yet. */
  canRemove: boolean;
  /** Take back an approval or a change request, saying why. */
  canDismiss: boolean;
}

const verdicts: Record<ForgeLatestReview["state"], string> = {
  APPROVED: "Approved",
  CHANGES_REQUESTED: "Changes requested",
  COMMENTED: "Commented",
  DISMISSED: "Dismissed",
  PENDING: "Review in progress",
};

/** The row's state in words: their latest review, and whether a new one is awaited. */
export function reviewerWords(row: ReviewerRow): string {
  if (!row.review) return "Awaiting review";
  const verdict = verdicts[row.review.state];
  return row.requested ? `${verdict} · asked again` : verdict;
}

const same = (a: string, b: string | null) => a.toLowerCase() === b?.toLowerCase();

/**
 * Everyone reviewing the PR, each once: those who reviewed (latest first, as GitHub lists them)
 * then those only asked. The author is never their own reviewer. What each row may offer
 * follows what GitHub lets this account do.
 */
export function reviewerRows(value: ForgePrReviewers): ReviewerRow[] {
  const rows: ReviewerRow[] = [];
  const requestedUser = (login: string) =>
    value.requested.some((r) => r.kind === "user" && same(r.login, login));
  for (const review of value.reviews) {
    if (same(review.login, value.author)) continue;
    const requested = requestedUser(review.login);
    rows.push({
      key: `user:${review.login.toLowerCase()}`,
      kind: "user",
      name: review.login,
      label: review.login,
      avatarUrl: review.avatarUrl,
      requested,
      review,
      canRerequest: value.canRequest && !requested,
      canRemove: value.canRequest && requested,
      canDismiss:
        value.canDismiss && (review.state === "APPROVED" || review.state === "CHANGES_REQUESTED"),
    });
  }
  for (const request of value.requested) {
    const name = request.kind === "user" ? request.login : request.slug;
    const key = `${request.kind}:${name.toLowerCase()}`;
    if (rows.some((row) => row.key === key)) continue;
    rows.push({
      key,
      kind: request.kind,
      name,
      label: request.kind === "user" ? request.login : request.name,
      avatarUrl: request.kind === "user" ? request.avatarUrl : undefined,
      requested: true,
      canRerequest: false,
      canRemove: value.canRequest,
      canDismiss: false,
    });
  }
  return rows;
}

/**
 * Who the request picker offers before anything is typed: GitHub's suggestions, minus the
 * author and anyone already asked.
 */
export function suggestedReviewers(value: ForgePrReviewers) {
  return value.suggested.filter(
    (person) =>
      !person.isAuthor &&
      !same(person.login, value.author) &&
      !value.requested.some((r) => r.kind === "user" && same(r.login, person.login)),
  );
}

const outcomeOf: Partial<Record<ForgeLatestReview["state"], ReviewOutcome>> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes",
  COMMENTED: "commented",
  DISMISSED: "dismissed",
};

/** Each reviewer's standing review by login, from GitHub's reviewer read; pending ones aside. */
export function reviewOutcomes(value: ForgePrReviewers): Map<string, ReviewOutcome> {
  return new Map(
    value.reviews.flatMap((review) => {
      const outcome = outcomeOf[review.state];
      return outcome ? [[review.login, outcome] as const] : [];
    }),
  );
}
