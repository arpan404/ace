import type { ForgeReactionContent, ForgeReviewAction, ForgeReviewState } from "@ace/protocol";

/*
 * Who may write what on a pull request's conversation: the guards the web's PR page and the
 * phone's share before a review write is sent. Pure.
 */

/** Why the comment surfaces are off on a conversation locked to this account. */
export const lockedText =
  "This conversation is locked. Only collaborators who can push can comment.";

/** What a locked conversation refuses from someone who can't push. */
export const lockedKinds: ReadonlySet<ForgeReviewAction["kind"]> = new Set([
  "conversation",
  "reply",
  "line.comment",
  "submit",
  "draft.save",
  "comment.edit",
  "reaction.add",
  "reaction.remove",
]);

/** Locked to this account: locked, and GitHub doesn't let it comment anyway. */
export function commentsLockedFor(
  conversation: { locked: boolean; viewerCanComment: boolean } | undefined,
): boolean {
  return !!conversation?.locked && !conversation.viewerCanComment;
}

/** Why the viewer can't give a verdict here, or undefined when they can. */
export function verdictBlocked(
  state: Pick<ForgeReviewState, "viewer" | "canReview">,
  author: string,
  open: boolean,
): string | undefined {
  if (state.viewer === author)
    return "You can't approve or request changes on your own pull request.";
  if (!open) return "Only an open pull request takes an approval or a change request.";
  if (!state.canReview) return "GitHub doesn't let this account approve this pull request.";
  return undefined;
}

/** What uncertain review writes say until the person reconciles them. */
export const reviewUncertainText = "Review change not confirmed";

/** A review write whose answer was lost, in the web's words. */
export const reviewLostText =
  "Couldn't confirm the action. Refresh and reconcile its result; your draft is retained.";

/** GitHub's reactions in its own order, with their names and the emoji GitHub shows. */
export const forgeReactions: readonly {
  content: ForgeReactionContent;
  label: string;
  emoji: string;
}[] = [
  { content: "+1", label: "Thumbs up", emoji: "👍" },
  { content: "-1", label: "Thumbs down", emoji: "👎" },
  { content: "laugh", label: "Laugh", emoji: "😄" },
  { content: "hooray", label: "Hooray", emoji: "🎉" },
  { content: "confused", label: "Confused", emoji: "😕" },
  { content: "heart", label: "Heart", emoji: "❤️" },
  { content: "rocket", label: "Rocket", emoji: "🚀" },
  { content: "eyes", label: "Eyes", emoji: "👀" },
];

/** A hosted comment's text as its author wrote it, without ace's publication marker. */
export { authoredReviewComment } from "@ace/forge/review-comment-body";
