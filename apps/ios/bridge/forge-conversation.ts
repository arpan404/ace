import type { ForgeComment, ForgePrStatus, ForgeReviewState } from "@ace/protocol";
import {
  authoredReviewComment,
  canHide,
  commentUrl,
  forgeReactions,
  hiddenReasonOf,
  hiddenWord,
  lockedText,
  threadPlace,
} from "@ace/ui-core";
import type { Preview } from "./agents.ts";

/*
 * A pull request's comments and line conversations as the phone draws them, with what this
 * account may do to each, decided by the web's rules (`forge-comments`, `forge-review-rules`).
 * Pure: the caller passes the review state it read and a memory of the bodies shown, which a
 * later edit or delete is pinned to.
 */

type ReviewThread = ForgePrStatus["reviewThreads"][number];
export type CommentSource = "issue" | "inline";

export interface ReactionView {
  content: string;
  emoji: string;
  label: string;
  count: number;
  viewer: boolean;
}
export interface CommentView {
  /** `issue:12`, `inline:34`, `review:56`: one comment wherever it shows. */
  id: string;
  commentId: number;
  source: "issue" | "inline" | "review";
  author: string;
  at: number | null;
  body: string;
  /** "Hidden as off topic" while GitHub hides it; its text then waits behind Show. */
  hidden: string | null;
  /** Every reaction GitHub offers, counted; empty when reactions can't be read or given. */
  reactions: ReactionView[];
  url: string;
  quote: boolean;
  edit: boolean;
  remove: boolean;
  hide: boolean;
  unhide: boolean;
  /** What Edit opens with: the text as its author wrote it. */
  editBody: string;
}
export interface ThreadView {
  id: string;
  /** "src/a.ts:12" or "src/a.ts:12–15". */
  place: string;
  path: string;
  line: number | null;
  side: "LEFT" | "RIGHT";
  resolved: boolean;
  outdated: boolean;
  canResolve: boolean;
  canReply: boolean;
  /** Why the reply box is off, when it shows but can't be used. */
  replyOff: string | null;
  comments: CommentView[];
}

/** The bodies the person last saw, by `source:id`: what an edit or delete expects to replace. */
export type ShownBodies = Map<string, string>;
export const shownKey = (source: CommentSource, id: number) => `${source}:${id}`;

export interface Conversation {
  state: ForgeReviewState | undefined;
  /** The pull request's address, under which each comment has its own. */
  url: string;
  /** Locked to this account: comments, reviews and reactions are refused. */
  locked: boolean;
  preview: Preview;
  shown: ShownBodies;
}

const epoch = (at: string | null | undefined) => {
  const parsed = at ? Date.parse(at) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

/** Writes that reach GitHub take a review state read and an unlocked conversation. */
const writable = (conversation: Conversation) => !!conversation.state && !conversation.locked;

function reactionsOf(conversation: Conversation, comment: ForgeComment): ReactionView[] {
  const known = conversation.state?.reactions;
  // Without the viewer's own reactions a press can't know whether it adds or removes.
  if (!known || comment.kind === "review" || !writable(conversation)) return [];
  const groups =
    known.find(
      (entry) => entry.subject.kind === comment.kind && entry.subject.commentId === comment.id,
    )?.groups ?? [];
  return forgeReactions.map((reaction) => {
    const group = groups.find((each) => each.content === reaction.content);
    return {
      content: reaction.content,
      emoji: reaction.emoji,
      label: reaction.label,
      count: group?.count ?? 0,
      viewer: group?.viewer ?? false,
    };
  });
}

export function commentView(conversation: Conversation, comment: ForgeComment): CommentView {
  const { state } = conversation;
  const source = comment.kind === "review" ? undefined : comment.kind;
  const reason = hiddenReasonOf(state, comment);
  const own = !!state && !!source && comment.author === state.viewer;
  const hideable = !!source && canHide(state, comment);
  if (source) conversation.shown.set(shownKey(source, comment.id), comment.body);
  return {
    id: `${comment.kind}:${comment.id}`,
    commentId: comment.id,
    source: comment.kind,
    author: conversation.preview(comment.author, 100),
    at: epoch(comment.createdAt ?? comment.updatedAt),
    body: conversation.preview(comment.body, 65_536),
    hidden: reason === undefined ? null : `Hidden as ${hiddenWord(reason)}`,
    reactions: reactionsOf(conversation, comment),
    url: commentUrl(conversation.url, comment),
    // Only where the viewer can answer: a quote with no box to take it would be lost.
    quote: writable(conversation) && !!state?.canComment && comment.body.trim() !== "",
    edit: own && writable(conversation),
    remove: own && !!state,
    hide: hideable && reason === undefined,
    unhide: hideable && reason !== undefined,
    editBody: own ? conversation.preview(authoredReviewComment(comment.body), 65_536) : "",
  };
}

export function threadView(conversation: Conversation, thread: ReviewThread): ThreadView {
  const { state } = conversation;
  const answers = !!state?.canComment || conversation.locked;
  return {
    id: thread.id,
    place: conversation.preview(threadPlace(thread), 4_200),
    path: conversation.preview(thread.file, 4_096),
    line: thread.line,
    side: thread.side ?? "RIGHT",
    resolved: thread.resolved,
    outdated: thread.outdated,
    canResolve: !!state?.resolvableThreads.includes(thread.id),
    canReply: answers,
    replyOff: conversation.locked ? lockedText : null,
    comments: thread.comments.slice(0, 200).map((comment) => commentView(conversation, comment)),
  };
}
