import type { ClientApi } from "@ace/client";
import type { ReviewReply, ReviewSession, ThreadId, WorkspaceId } from "@ace/protocol";
import { actionErrorText } from "@ace/ui-core";
import type { LocalStore } from "../store.ts";
import { patch, record, review, type ReviewDraft } from "./drafts.ts";

/*
 * What a reviewer does beyond sending comments (ADR 0038): apply a suggested change to the
 * thread's checkout, reply under a comment, and approve or request changes on the review.
 * Each goes through the daemon, so other devices and agents see the same review.
 */

type Thread = { id: ThreadId; workspaceId: WorkspaceId };
type Drafts = LocalStore<readonly ReviewDraft[]>;

const message = (error: unknown) =>
  error instanceof Error ? error.message : actionErrorText(undefined);

/**
 * Apply a comment's suggestion: the daemon patches the selected lines in the thread's worktree
 * (refusing if they changed since), then the comment is resolved, since nothing is left for the
 * agent to do. A draft is recorded first.
 */
export async function applySuggestion(
  client: ClientApi,
  store: Drafts,
  thread: Thread,
  key: string,
): Promise<void> {
  const draft = store.get().find((candidate) => candidate.key === key);
  if (!draft || draft.suggestion === undefined) return;
  const only = new Set([key]);
  const before = draft.state;
  patch(store, only, ({ error: _error, ...d }) => ({ ...d, state: "resolving" }));
  try {
    const { sessionId, commentIds } = await record(client, store, thread, [draft]);
    const commentId = commentIds[0] ?? "";
    await review(client, { type: "review.applySuggestion", sessionId, commentId });
    await review(client, { type: "review.resolve", sessionId, commentId, resolved: true });
    patch(store, only, (d) => ({
      ...d,
      state: "resolved",
      applied: true,
      anchor: "addressed-pending-review",
    }));
  } catch (error) {
    patch(store, only, (d) => ({ ...d, state: before, error: message(error) }));
  }
}

/** Every reply under a recorded comment, oldest first (bounded: ten pages of twenty). */
export async function readReplies(
  client: ClientApi,
  sessionId: string,
  commentId: string,
): Promise<ReviewReply[]> {
  const replies: ReviewReply[] = [];
  let cursor = "";
  for (let page = 0; page < 10; page++) {
    const data = await review(client, {
      type: "review.list",
      sessionId,
      commentId,
      cursor,
      limit: 20,
    });
    replies.push(...(data.replies ?? []));
    if (!data.nextCursor || !data.replies?.length) break;
    cursor = data.nextCursor;
  }
  return replies;
}

export async function reply(
  client: ClientApi,
  draft: ReviewDraft,
  text: string,
): Promise<ReviewReply> {
  if (!draft.sessionId || !draft.commentId)
    throw new Error("Send the comment first: replies go under recorded comments.");
  const data = await review(client, {
    type: "review.reply",
    sessionId: draft.sessionId,
    commentId: draft.commentId,
    text,
  });
  if (!data.reply) throw new Error(actionErrorText(undefined));
  return data.reply;
}

/**
 * Approve the thread's newest review, or mark it as needing changes. Without a review yet, one
 * is opened for the working tree, so a change can be approved without a comment.
 */
export async function setReviewStatus(
  client: ClientApi,
  thread: Thread,
  session: ReviewSession | null | undefined,
  status: "approved" | "changes-requested",
): Promise<ReviewSession | undefined> {
  const sessionId =
    session?.id ??
    (
      await review(client, {
        type: "review.open",
        source: {
          workspaceId: thread.workspaceId,
          threadId: thread.id,
          from: { kind: "commit", ref: "HEAD" },
          to: { kind: "working-tree" },
        },
      })
    ).session?.id;
  if (!sessionId) throw new Error("The daemon didn't open a review session: try again.");
  return (await review(client, { type: "review.status", sessionId, status })).session;
}
