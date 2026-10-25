import { ForgeRepository, type ForgePrDetail, type ForgeReviewState } from "@ace/protocol";
import {
  draftPlace,
  eventText,
  lifecycleWords,
  lockedText,
  prTimelineItems,
  referenceText,
  reviewVerdictWords,
  verdictBlocked,
  type PrTimelineItem,
} from "@ace/ui-core";
import { z } from "zod";
import type { Preview } from "./agents.ts";
import {
  commentView,
  threadView,
  type CommentView,
  type Conversation,
  type ShownBodies,
  type ThreadView,
} from "./forge-conversation.ts";
import {
  lockedOut,
  prActivity,
  prCommits,
  prDetail,
  prLifecycle,
  prReviewState,
} from "./forge-pr-reads.ts";
import type { ForgeReads } from "./forge-reads.ts";

/*
 * A pull request's Timeline as the phone shows it, oldest first with the comment box at the
 * newest end: the web's grouped timeline (`prTimelineItems`), its comment box and its Review
 * sheet, each with what this account may do, and the review writes GitHub hasn't confirmed.
 */

export const ForgeTimelineRequest = z.object({
  type: z.literal("forge.pull.timeline"),
  project: z.string().min(1).max(512),
  number: z.number().int().positive(),
  repository: ForgeRepository.optional(),
});
export type ForgeTimelineRequest = z.infer<typeof ForgeTimelineRequest>;

export type TimelineRow =
  | { kind: "comment"; id: string; comment: CommentView }
  | {
      kind: "review";
      id: string;
      comment: CommentView;
      words: string;
      tone: string | null;
      stale: boolean;
    }
  | { kind: "thread"; id: string; thread: ThreadView }
  | {
      kind: "event";
      id: string;
      actor: string;
      text: string;
      tone: string | null;
      at: number | null;
    }
  | { kind: "commit"; id: string; sha: string; title: string; author: string; at: number | null }
  | { kind: "references"; id: string; lines: { actor: string; text: string }[] };

export interface ReviewSheet {
  /** Line comments waiting in the review, sent with it. */
  drafts: { id: string; place: string; body: string; outdated: boolean }[];
  verdicts: { event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES"; label: string; off: boolean }[];
  /** Why Approve and Request changes are off. */
  blocked: string | null;
  /** Why the whole review is off. */
  refused: string | null;
  /** Why it can't be sent until the page is read again (a moved head, outdated drafts). */
  stale: string | null;
  headSha: string;
}

export interface TimelineReply {
  type: "forge.pull.timeline";
  number: number;
  repository: ForgeRepository;
  title: string;
  url: string;
  rows: TimelineRow[];
  /** Activity between the first and newest pages was left out; it is on GitHub. */
  partial: boolean;
  /** The comment box at the newest end; null where this account can't comment. */
  box: { off: string | null } | null;
  review: ReviewSheet | null;
  /** Review writes whose outcome GitHub hasn't confirmed, to reconcile. */
  uncertain: string[];
  /** Why the review state couldn't be read: comments show, writes wait. */
  unread: string | null;
}

const epoch = (at: string | null | undefined) => {
  const parsed = at ? Date.parse(at) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

function row(conversation: Conversation, item: PrTimelineItem, preview: Preview): TimelineRow[] {
  switch (item.kind) {
    case "comment":
      return [{ kind: "comment", id: item.id, comment: commentView(conversation, item.comment) }];
    case "comments":
      // The phone shows a burst as its comments: there is room to read them one by one.
      return item.comments.map((comment) => ({
        kind: "comment",
        id: `comment:${comment.kind}:${comment.id}`,
        comment: commentView(conversation, comment),
      }));
    case "review": {
      const words = reviewVerdictWords[item.verdict];
      return [
        {
          kind: "review",
          id: item.id,
          comment: commentView(conversation, item.comment),
          words: words.text,
          tone: words.tone ?? null,
          stale: item.stale,
        },
      ];
    }
    case "thread":
      return [{ kind: "thread", id: item.id, thread: threadView(conversation, item.thread) }];
    case "lifecycle": {
      const words = lifecycleWords[item.state];
      return [
        {
          kind: "event",
          id: item.id,
          actor: preview(item.event.actor, 100),
          text: words.text,
          tone: words.tone,
          at: epoch(item.at),
        },
      ];
    }
    case "event":
      return [
        {
          kind: "event",
          id: item.id,
          actor: preview(item.event.actor, 100),
          text: preview(eventText(item.event), 400),
          tone: null,
          at: epoch(item.at),
        },
      ];
    case "commit":
      return [
        {
          kind: "commit",
          id: item.id,
          sha: item.commit.sha.slice(0, 7),
          title: preview(item.commit.message.split("\n")[0] ?? "", 300),
          author: preview(item.commit.author, 100),
          at: epoch(item.at),
        },
      ];
    case "references":
      return [
        {
          kind: "references",
          id: item.id,
          lines: item.references.slice(0, 50).map((reference) => ({
            actor: preview(reference.actor, 100),
            text: preview(referenceText(reference), 400),
          })),
        },
      ];
  }
}

const verdictLabels = [
  { event: "COMMENT", label: "Comment" },
  { event: "APPROVE", label: "Approve" },
  { event: "REQUEST_CHANGES", label: "Request changes" },
] as const;

/** The Review sheet, as the web's Review popover offers it; null where it doesn't show. */
export function reviewSheet(
  detail: ForgePrDetail,
  state: ForgeReviewState | undefined,
  locked: boolean,
  preview: Preview,
): ReviewSheet | null {
  if (!state) return null;
  const live = detail.status.state === "open" || detail.status.state === "draft";
  if (!state.drafts.length && !((state.canComment || locked) && live)) return null;
  const headSha = detail.status.headSha;
  const blocked = verdictBlocked(state, detail.author, live) ?? null;
  const outdated = state.drafts.filter((draft) => draft.anchor.commit !== headSha).length;
  return {
    drafts: state.drafts.map((draft) => ({
      id: draft.id,
      place: preview(draftPlace(draft.anchor), 4_200),
      body: preview(draft.body.split("\n")[0] ?? "", 300),
      outdated: draft.anchor.commit !== headSha,
    })),
    verdicts: verdictLabels.map((verdict) => ({
      event: verdict.event,
      label: verdict.label,
      off: locked || (verdict.event !== "COMMENT" && blocked !== null),
    })),
    blocked,
    refused: locked
      ? lockedText
      : state.canComment
        ? null
        : "GitHub doesn't let this account review.",
    stale:
      state.headSha !== headSha
        ? "The pull request changed. Refresh before submitting."
        : outdated
          ? "Some pending comments are on an older commit. Remove them to submit."
          : null,
    headSha,
  };
}

export async function readTimeline(
  reads: ForgeReads,
  request: ForgeTimelineRequest,
  preview: Preview,
  shown: ShownBodies,
): Promise<TimelineReply> {
  const detail = await prDetail(reads, request);
  const [state, lifecycle, activity, commits] = await Promise.all([
    prReviewState(reads, request),
    prLifecycle(reads, request),
    prActivity(reads, request),
    prCommits(reads, request, detail.status.headSha),
  ]);
  const locked = lockedOut(lifecycle);
  const conversation: Conversation = { state, url: detail.status.url, locked, preview, shown };
  const items = prTimelineItems(detail, commits.commits, activity.events, "oldest");
  return {
    type: "forge.pull.timeline",
    number: detail.status.ref.number,
    repository: detail.status.ref.repository,
    title: preview(detail.status.title, 400),
    url: detail.status.url,
    rows: items.slice(-500).flatMap((item) => row(conversation, item, preview)),
    partial: activity.partial || commits.partial || items.length > 500,
    box: state && (state.canComment || locked) ? { off: locked ? lockedText : null } : null,
    review: reviewSheet(detail, state, locked, preview),
    uncertain: (state?.operations ?? [])
      .filter((op) => op.state === "uncertain")
      .map((op) => op.id),
    unread: state ? null : "Couldn't read GitHub's review state. Refresh to comment.",
  };
}
