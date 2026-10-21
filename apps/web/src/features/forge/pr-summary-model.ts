import type { ForgeComment, ForgePrStatus } from "@ace/protocol";
import { checkFixRequest } from "./pr-check-model.ts";

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

/** Something on the PR an agent could fix: a failing check or an open review thread. */
export type AttentionItem =
  | {
      kind: "check";
      key: string;
      title: string;
      detail: string;
      at: string | null;
      url: string | null;
    }
  | {
      kind: "thread";
      key: string;
      title: string;
      detail: string;
      at: string | null;
      author: string;
      body: string;
    };

/** Failing checks first, then review threads nobody resolved, each as one actionable row. */
export function attentionItems(
  status: Pick<ForgePrStatus, "checks" | "reviewThreads">,
): AttentionItem[] {
  const checks = status.checks
    .filter((check) => check.status === "failure")
    .map((check): AttentionItem => ({
      kind: "check",
      key: `check:${check.id}`,
      title: check.name,
      detail: check.conclusion ?? "failed",
      at: check.completedAt,
      url: check.url,
    }));
  const threads = status.reviewThreads
    .filter((thread) => !thread.resolved && thread.comments.length > 0)
    .map((thread): AttentionItem => {
      const first = thread.comments[0];
      return {
        kind: "thread",
        key: `thread:${thread.id}`,
        title: (first?.body ?? "").split("\n")[0] ?? "",
        detail: `${thread.file}:${thread.line ?? ""}`,
        at: first ? time(first) : null,
        author: first?.author ?? "",
        body: first?.body ?? "",
      };
    });
  return [...checks, ...threads];
}

/** What "Fix with agent" asks the agent, for the person to read over before sending. */
export function fixRequest(item: AttentionItem, pr: { number: number; url: string }): string {
  if (item.kind === "check")
    return checkFixRequest({ name: item.title, url: item.url }, pr, undefined);
  return `Address ${item.author}'s review comment on ${item.detail} in PR #${pr.number}:\n\n> ${item.body.split("\n").join("\n> ")}\n\nMake the change, push it, and reply on the thread.`;
}

export interface GlanceFile {
  path: string;
  /** "src/invoices/pdf/", empty at the root. */
  directory: string;
  name: string;
  additions: number;
  deletions: number;
  /** The file's share of the biggest file's change, 0 to 1. */
  scale: number;
}

/** The `limit` files that changed most, biggest first, each scaled against the biggest. */
export function biggestFiles(
  files: readonly { path: string; additions: number; deletions: number }[],
  limit: number,
): GlanceFile[] {
  const top = files
    .toSorted(
      (a, b) =>
        b.additions + b.deletions - (a.additions + a.deletions) || a.path.localeCompare(b.path),
    )
    .slice(0, limit);
  const most = Math.max(1, ...top.map((file) => file.additions + file.deletions));
  return top.map((file) => {
    const cut = file.path.lastIndexOf("/") + 1;
    return {
      path: file.path,
      directory: file.path.slice(0, cut),
      name: file.path.slice(cut),
      additions: file.additions,
      deletions: file.deletions,
      scale: (file.additions + file.deletions) / most,
    };
  });
}

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
