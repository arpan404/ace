import { z } from "zod";
import type { ForgeComment, ForgePrStatus } from "@ace/protocol";
import type { ForgeActivity, ForgeCommit, ForgePrDetail } from "@ace/protocol/forge-browser";

export type PrTimelineEntry =
  | { kind: "commit"; id: string; at: string | null; commit: ForgeCommit }
  | { kind: "comment"; id: string; at: string; comment: ForgeComment }
  | { kind: "event"; id: string; at: string | null; event: ForgeActivity };

/** Stable identities deduplicate REST timeline echoes of comments and commits. */
export function prTimeline(
  detail: ForgePrDetail,
  commits: readonly ForgeCommit[],
  events: readonly ForgeActivity[],
  order: "newest" | "oldest",
): PrTimelineEntry[] {
  const commentIds = new Set(detail.status.comments.map((c) => `${c.kind}:${c.id}`));
  const commitIds = new Set(commits.map((c) => c.sha));
  const rows: PrTimelineEntry[] = [
    ...commits.map((commit): PrTimelineEntry => ({
      kind: "commit",
      id: `commit:${commit.sha}`,
      at: commit.date,
      commit,
    })),
    ...detail.status.comments.map((comment): PrTimelineEntry => ({
      kind: "comment",
      id: `comment:${comment.kind}:${comment.id}`,
      at: comment.createdAt ?? comment.updatedAt,
      comment,
    })),
    ...events
      .filter(
        (event) =>
          !(
            (event.event === "commented" && commentIds.has(`issue:${event.id}`)) ||
            (event.event === "reviewed" && commentIds.has(`review:${event.id}`))
          ) && !(event.event === "committed" && event.commitSha && commitIds.has(event.commitSha)),
      )
      .map((event): PrTimelineEntry => ({
        kind: "event",
        id: `event:${event.event}:${event.id}`,
        at: event.at,
        event,
      })),
  ];
  if (detail.createdAt && !events.some((e) => e.event === "opened"))
    rows.push({
      kind: "event",
      id: "opened",
      at: detail.createdAt,
      event: {
        id: "opened",
        event: "opened",
        actor: detail.author,
        actorAvatarUrl: detail.authorAvatarUrl,
        at: detail.createdAt,
        raw: null,
      },
    });
  const unique = [...new Map(rows.map((row) => [row.id, row])).values()];
  return unique.toSorted((a, b) => {
    const aTime = a.at ? Date.parse(a.at) : NaN;
    const bTime = b.at ? Date.parse(b.at) : NaN;
    // Undated provider events stay visible, following dated activity in either order.
    if (!Number.isFinite(aTime)) return Number.isFinite(bTime) ? 1 : a.id.localeCompare(b.id);
    if (!Number.isFinite(bTime)) return -1;
    return (order === "newest" ? bTime - aTime : aTime - bTime) || a.id.localeCompare(b.id);
  });
}
export function eventText(event: ForgeActivity): string {
  const titles: Record<string, string> = {
    opened: "Pull request opened",
    closed: "closed the pull request",
    reopened: "reopened the pull request",
    merged: "merged the pull request",
    reviewed: "submitted a review",
    labeled: "added label",
    unlabeled: "removed label",
    review_requested: "requested review from",
    review_request_removed: "removed review request for",
    head_ref_force_pushed: "force-pushed the branch",
    head_ref_deleted: "deleted the branch",
    ready_for_review: "marked ready for review",
    convert_to_draft: "converted to draft",
    renamed: "renamed the pull request",
    committed: "added a commit",
  };
  return `${titles[event.event] ?? event.event.replaceAll("_", " ")}${event.subject ? ` ${event.subject}` : ""}`;
}

/* Grouped timeline: what the Timeline tab renders, one item per row. */

export type PrReviewVerdict = "approved" | "changes" | "commented" | "dismissed" | "pending";
export type PrLifecycleState = "opened" | "merged" | "closed" | "reopened";
/** A linked pull request or issue (cross-reference), or a commit that mentions this one. */
export type PrReference = {
  id: string;
  actor: string;
  at: string | null;
  target:
    | { kind: "item"; number: number; title: string; url: string | null; pullRequest: boolean }
    | { kind: "commit"; sha: string }
    | null;
};
type CommentEntry = Extract<PrTimelineEntry, { kind: "comment" }>;
export type PrTimelineItem =
  | Extract<PrTimelineEntry, { kind: "commit" | "comment" | "event" }>
  | {
      kind: "review";
      id: string;
      at: string;
      comment: ForgeComment;
      verdict: PrReviewVerdict;
      stale: boolean;
    }
  | {
      kind: "lifecycle";
      id: string;
      at: string | null;
      state: PrLifecycleState;
      event: ForgeActivity;
    }
  | { kind: "references"; id: string; at: string | null; references: PrReference[] }
  | { kind: "thread"; id: string; at: string; thread: ForgePrStatus["reviewThreads"][number] }
  | { kind: "comments"; id: string; at: string; comments: ForgeComment[]; authors: string[] };

/** At least this many comments in a row, each this close to the last, fold into one burst. */
export const COMMENT_BURST_MIN = 3;
export const COMMENT_BURST_GAP_MS = 60 * 60_000;
/** GitHub records "closed" alongside "merged"; within this window it is the same moment. */
const MERGE_CLOSE_WINDOW_MS = 2 * 60_000;
const REFERENCE_EVENTS = new Set(["referenced", "cross-referenced"]);
const LIFECYCLE_STATES: readonly PrLifecycleState[] = ["opened", "merged", "closed", "reopened"];

// Provider raw records are decoded leniently: anything that doesn't match is simply not shown.
const CrossReference = z.object({
  source: z.object({
    issue: z.object({
      number: z.number().int().positive(),
      title: z.string().max(1_024).optional(),
      html_url: z.string().max(2_048).optional(),
      pull_request: z.unknown().optional(),
    }),
  }),
});
const CommitMention = z.object({ commit_id: z.string().regex(/^[a-fA-F0-9]{7,64}$/) });

const time = (at: string | null | undefined) => (at ? Date.parse(at) : NaN);
const lifecycleState = (event: string) => LIFECYCLE_STATES.find((state) => state === event);

export function reviewVerdict(state: string | undefined): PrReviewVerdict {
  switch (state?.toUpperCase()) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes";
    case "DISMISSED":
      return "dismissed";
    case "PENDING":
      return "pending";
    default:
      return "commented";
  }
}

function reference(event: ForgeActivity): PrReference {
  const base = { id: event.id, actor: event.actor, at: event.at };
  const cross = CrossReference.safeParse(event.raw);
  if (cross.success) {
    const issue = cross.data.source.issue;
    return {
      ...base,
      target: {
        kind: "item",
        number: issue.number,
        title: issue.title ?? "",
        url: issue.html_url?.startsWith("https://") ? issue.html_url : null,
        pullRequest: issue.pull_request !== undefined && issue.pull_request !== null,
      },
    };
  }
  const sha = event.commitSha ?? CommitMention.safeParse(event.raw).data?.commit_id;
  return { ...base, target: sha ? { kind: "commit", sha } : null };
}

/**
 * A verdict stops describing the pull request once it is dismissed, once its author gives a
 * later verdict, or once the branch has moved past the commit it was given on.
 */
function staleReviews(
  comments: readonly ForgeComment[],
  events: readonly ForgeActivity[],
  headSha: string,
): Set<number> {
  const reviewedAt = new Map<string, string>();
  for (const event of events) {
    const sha = event.event === "reviewed" && CommitMention.safeParse(event.raw).data?.commit_id;
    if (sha) reviewedAt.set(event.id, sha.toLowerCase());
  }
  const stale = new Set<number>();
  const latest = new Map<string, ForgeComment>();
  const reviews = comments
    .filter((comment) => comment.kind === "review")
    .toSorted(
      (a, b) => time(a.createdAt ?? a.updatedAt) - time(b.createdAt ?? b.updatedAt) || a.id - b.id,
    );
  for (const review of reviews) {
    const verdict = reviewVerdict(review.reviewState);
    const sha = reviewedAt.get(String(review.id));
    if (verdict === "dismissed" || (sha && headSha && sha !== headSha.toLowerCase()))
      stale.add(review.id);
    if (verdict !== "approved" && verdict !== "changes") continue;
    const previous = latest.get(review.author);
    if (previous) stale.add(previous.id);
    latest.set(review.author, review);
  }
  return stale;
}

/** Closed events recorded at the moment of a merge say nothing the merged row doesn't. */
function foldMergeClose(entries: readonly PrTimelineEntry[]): PrTimelineEntry[] {
  const merges = entries.flatMap((entry) =>
    entry.kind === "event" && entry.event.event === "merged" ? [time(entry.at)] : [],
  );
  return entries.filter(
    (entry) =>
      !(
        entry.kind === "event" &&
        entry.event.event === "closed" &&
        merges.some((at) => Math.abs(at - time(entry.at)) <= MERGE_CLOSE_WINDOW_MS)
      ),
  );
}

function single(entry: PrTimelineEntry, stale: ReadonlySet<number>): PrTimelineItem {
  if (entry.kind === "comment" && entry.comment.kind === "review")
    return {
      kind: "review",
      id: entry.id,
      at: entry.at,
      comment: entry.comment,
      verdict: reviewVerdict(entry.comment.reviewState),
      stale: stale.has(entry.comment.id),
    };
  const state = entry.kind === "event" ? lifecycleState(entry.event.event) : undefined;
  if (entry.kind === "event" && state)
    return { kind: "lifecycle", id: entry.id, at: entry.at, state, event: entry.event };
  return entry;
}

/**
 * The Timeline tab's rows: `prTimeline` with merge-time closes folded away, reviews given a
 * verdict, review comments gathered into their conversations, runs of references collapsed into one row and bursts of comments into another.
 * Groups form oldest-first, so a group keeps its identity when the order flips.
 */
export function prTimelineItems(
  detail: ForgePrDetail,
  commits: readonly ForgeCommit[],
  events: readonly ForgeActivity[],
  order: "newest" | "oldest",
): PrTimelineItem[] {
  const entries = foldMergeClose(prTimeline(detail, commits, events, "oldest"));
  const stale = staleReviews(detail.status.comments, events, detail.status.headSha);
  const threadOf = new Map(
    detail.status.reviewThreads.flatMap((thread) =>
      thread.comments.map((comment) => [comment.id, thread] as const),
    ),
  );
  // Where each conversation shows: its first comment the timeline has. Past the read cap a
  // root may be missing; the conversation then shows at its first reply that is present.
  const present = new Set(
    detail.status.comments.filter((c) => c.kind === "inline").map((c) => c.id),
  );
  const shownAt = new Map(
    detail.status.reviewThreads.flatMap((thread) => {
      const first = thread.comments.find((comment) => present.has(comment.id));
      return first ? [[thread.id, first.id] as const] : [];
    }),
  );
  const items: PrTimelineItem[] = [];
  let references: PrReference[] = [];
  let burst: CommentEntry[] = [];
  const flushReferences = () => {
    const first = references[0];
    if (first)
      items.push({
        kind: "references",
        id: `references:${first.id}`,
        at: references.findLast((item) => item.at)?.at ?? null,
        references,
      });
    references = [];
  };
  const flushBurst = () => {
    const first = burst[0];
    const last = burst.at(-1);
    if (first && last && burst.length >= COMMENT_BURST_MIN)
      items.push({
        kind: "comments",
        id: `comments:${first.id}`,
        at: last.at,
        comments: burst.map((entry) => entry.comment),
        authors: [...new Set(burst.map((entry) => entry.comment.author))],
      });
    else items.push(...burst);
    burst = [];
  };
  for (const entry of entries) {
    if (entry.kind === "event" && REFERENCE_EVENTS.has(entry.event.event)) {
      flushBurst();
      references.push(reference(entry.event));
      continue;
    }
    flushReferences();
    // A review comment shows as its whole conversation, once, where the conversation began.
    const thread =
      entry.kind === "comment" && entry.comment.kind === "inline"
        ? threadOf.get(entry.comment.id)
        : undefined;
    if (entry.kind === "comment" && thread) {
      if (shownAt.get(thread.id) !== entry.comment.id) continue;
      flushBurst();
      items.push({ kind: "thread", id: `thread:${thread.id}`, at: entry.at, thread });
      continue;
    }
    if (entry.kind === "comment" && entry.comment.kind !== "review") {
      const previous = burst.at(-1);
      if (previous && !(time(entry.at) - time(previous.at) <= COMMENT_BURST_GAP_MS)) flushBurst();
      burst.push(entry);
      continue;
    }
    flushBurst();
    items.push(single(entry, stale));
  }
  flushReferences();
  flushBurst();
  if (order === "oldest") return items;
  // Undated activity follows dated activity in either order, as in `prTimeline`.
  const dated = items.filter((item) => Number.isFinite(time(item.at)));
  return [...dated.toReversed(), ...items.filter((item) => !Number.isFinite(time(item.at)))];
}
