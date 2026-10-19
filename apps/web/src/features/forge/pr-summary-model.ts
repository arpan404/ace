import type { ForgeComment, ForgePrStatus } from "@ace/protocol";

/*
 * What the Summary tab lists, worked out from the PR detail without rendering: each reviewer's
 * latest verdict, and the conversation as cards (comments and review threads) with the
 * filters and paging the tab offers. Pure.
 */

export type ReviewOutcome = "approved" | "changes" | "commented" | "dismissed";

const outcomes: Record<string, ReviewOutcome> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes",
  COMMENTED: "commented",
  DISMISSED: "dismissed",
};

const time = (comment: Pick<ForgeComment, "createdAt" | "updatedAt">) =>
  comment.createdAt ?? comment.updatedAt;

/** Each reviewer's most recent review verdict, by login. */
export function reviewerOutcomes(comments: readonly ForgeComment[]): Map<string, ReviewOutcome> {
  const latest = new Map<string, { at: string; outcome: ReviewOutcome }>();
  for (const comment of comments) {
    if (comment.kind !== "review" || !comment.reviewState) continue;
    const outcome = outcomes[comment.reviewState.toUpperCase()];
    if (!outcome) continue;
    const seen = latest.get(comment.author);
    if (!seen || time(comment) >= seen.at)
      latest.set(comment.author, { at: time(comment), outcome });
  }
  return new Map([...latest].map(([author, value]) => [author, value.outcome]));
}

export const reviewOutcomeLabels: Record<ReviewOutcome, string> = {
  approved: "Approved",
  changes: "Changes requested",
  commented: "Commented",
  dismissed: "Dismissed",
};

/** A GitHub App or bot account: "dependabot[bot]", "ci-bot". */
export const isBot = (author: string) => /\[bot\]$|(^|-)bot$/i.test(author);

export type ConversationItem =
  | { kind: "comment"; key: string; at: string; comment: ForgeComment }
  | {
      kind: "thread";
      key: string;
      at: string;
      thread: ForgePrStatus["reviewThreads"][number];
    };

export interface ConversationView {
  items: ConversationItem[];
  /** Cards the filters hide. */
  filtered: number;
  /** Older cards beyond the page shown. */
  older: number;
  total: number;
}

/**
 * The conversation as cards, newest or oldest first: top-level and review comments, plus one
 * card per review thread (whose inline comments it holds, so they aren't listed twice). Only
 * the newest `limit` cards are shown.
 */
export function conversation(
  status: Pick<ForgePrStatus, "comments" | "reviewThreads">,
  options: { bots: boolean; resolved: boolean; order: "newest" | "oldest"; limit: number },
): ConversationView {
  const threaded = new Set(status.reviewThreads.flatMap((t) => t.comments.map((c) => c.id)));
  const all: ConversationItem[] = [
    ...status.comments
      .filter((comment) => !(comment.kind === "inline" && threaded.has(comment.id)))
      .map((comment) => ({
        kind: "comment" as const,
        key: `${comment.kind}:${comment.id}`,
        at: time(comment),
        comment,
      })),
    ...status.reviewThreads.map((thread) => ({
      kind: "thread" as const,
      key: `thread:${thread.id}`,
      at: thread.comments[0] ? time(thread.comments[0]) : "",
      thread,
    })),
  ];
  const shown = all.filter((item) =>
    item.kind === "thread"
      ? options.resolved || !item.thread.resolved
      : (options.bots || !isBot(item.comment.author)) &&
        (options.resolved || item.comment.reviewState?.toUpperCase() !== "DISMISSED"),
  );
  const newest = shown.toSorted((a, b) => b.at.localeCompare(a.at) || b.key.localeCompare(a.key));
  const page = newest.slice(0, Math.max(0, options.limit));
  return {
    items: options.order === "newest" ? page : page.toReversed(),
    filtered: all.length - shown.length,
    older: newest.length - page.length,
    total: all.length,
  };
}
