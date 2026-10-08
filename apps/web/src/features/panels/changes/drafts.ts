import { ThreadId as ThreadIdSchema } from "@ace/protocol";
import type { ClientApi } from "@ace/client";
import { actionErrorText } from "@ace/ui-core";
import type {
  CommandPayload,
  ReviewComment,
  ReviewData,
  ReviewSession,
  ThreadId,
  WorkspaceId,
} from "@ace/protocol";
import type { LocalStore } from "../store.ts";

/*
 * Line comments in the Changes tab and their way to the agent (ADR 0038 review mode):
 *
 *   draft ──Send──▶ sending ──▶ sent ──Resolve──▶ resolved
 *     ▲               │                  ◀─Reopen──┘
 *     └── failed ◀────┘ (Retry sends again)
 *
 * A draft lives on this device until it is sent. Sending opens (or reuses) the daemon's review
 * session for the thread's working tree, records each comment on its line and asks the daemon to
 * deliver them to the thread's agent. Resolving is a person's call (the daemon never resolves on
 * its own); the daemon also reports when a later edit moved past a comment (outdated) or
 * touched its lines (addressed, waiting for your review).
 */

export type DraftState = "draft" | "sending" | "sent" | "failed" | "resolving" | "resolved";

/** What the daemon last said about a sent comment's anchor. */
export type AnchorState = ReviewComment["anchor"]["state"];

export interface ReviewDraft {
  key: string;
  threadId: string;
  file: string;
  side: "old" | "new";
  /** The first line commented on, and the last when it covers a range. */
  line: number;
  end?: number | undefined;
  text: string;
  /** What the lines should read instead ("Suggest change"), applied to the checkout on Apply. */
  suggestion?: string | undefined;
  /** The suggestion was applied to the checkout. */
  applied?: boolean | undefined;
  state: DraftState;
  error?: string | undefined;
  /** Set once the daemon has recorded it, so a retry does not record it twice. */
  commentId?: string | undefined;
  /** The review session it was recorded in, to resolve it later. */
  sessionId?: string | undefined;
  /** The daemon's view of where the comment sits now, once read back. */
  anchor?: AnchorState | undefined;
  createdAt: number;
}

export const draftKey = (threadId: string, file: string, side: "old" | "new", line: number) =>
  `${threadId}\u0000${file}\u0000${side}\u0000${line}`;

/** Still to go to the agent: written and not yet sent, or a send that failed. */
export const isPending = (draft: ReviewDraft) =>
  draft.state === "draft" || draft.state === "failed";
/** Delivered and not yet resolved. */
export const isOpen = (draft: ReviewDraft) => draft.state === "sent" || draft.state === "resolving";

export function saveDraft(
  store: LocalStore<readonly ReviewDraft[]>,
  draft: Omit<ReviewDraft, "key" | "state">,
): void {
  const key = draftKey(draft.threadId, draft.file, draft.side, draft.line);
  // Editing a recorded comment records the new words as a new comment.
  store.set((drafts) => [
    ...drafts.filter((existing) => existing.key !== key),
    { ...draft, key, state: "draft" },
  ]);
}
export function discardDraft(store: LocalStore<readonly ReviewDraft[]>, key: string): void {
  store.set((drafts) => drafts.filter((draft) => draft.key !== key));
}

/** A review command; a refusal becomes an error saying what happened and what to do. */
export async function review(client: ClientApi, payload: CommandPayload): Promise<ReviewData> {
  const result = await client.command(payload);
  if (!result.ok) throw new Error(actionErrorText(result.error));
  return result.review ?? {};
}

/** Where a draft's comment sits: its lines on one side of the diff. */
export const positionOf = (draft: ReviewDraft) => ({
  file: draft.file,
  side: draft.side,
  start: draft.line,
  end: draft.end ?? draft.line,
});

export function patch(
  store: LocalStore<readonly ReviewDraft[]>,
  keys: ReadonlySet<string>,
  change: (draft: ReviewDraft) => ReviewDraft,
) {
  store.set((drafts) => drafts.map((draft) => (keys.has(draft.key) ? change(draft) : draft)));
}

/**
 * Record drafts with the daemon: open (or reuse) the review session for the thread's working
 * tree and add each comment on its lines, unless it is already there. Drafts remember their
 * comment and session, so doing it again records nothing twice.
 */
export async function record(
  client: ClientApi,
  store: LocalStore<readonly ReviewDraft[]>,
  thread: { id: ThreadId; workspaceId: WorkspaceId },
  drafts: readonly ReviewDraft[],
): Promise<{ sessionId: string; commentIds: string[] }> {
  const previous = drafts[0]?.sessionId;
  const reuse =
    previous && drafts.every((draft) => draft.sessionId === previous && draft.commentId);
  const opened = reuse
    ? await review(client, { type: "review.list", sessionId: previous, cursor: "", limit: 1 })
    : await review(client, {
        type: "review.open",
        source: {
          workspaceId: thread.workspaceId,
          threadId: thread.id,
          from: { kind: "commit", ref: "HEAD" },
          to: { kind: "working-tree" },
        },
      });
  const sessionId = opened.session?.id;
  if (!sessionId) throw new Error("The daemon didn't open a review session: try again.");
  const commentIds: string[] = [];
  for (const draft of drafts) {
    // A comment recorded in another session (an older checkout) is recorded again here.
    if (draft.commentId && draft.sessionId === sessionId) {
      commentIds.push(draft.commentId);
      continue;
    }
    const { comment } = await review(client, {
      type: "review.comment",
      sessionId,
      position: positionOf(draft),
      text: draft.text,
      ...(draft.suggestion === undefined ? {} : { suggestion: draft.suggestion }),
    });
    if (!comment) throw new Error("The daemon didn't record the comment: try again.");
    const commentId = comment.id;
    commentIds.push(commentId);
    patch(store, new Set([draft.key]), (d) => ({ ...d, commentId, sessionId }));
  }
  return { sessionId, commentIds };
}

/**
 * Review mode (ADR 0038): record the comments, then ask the daemon to deliver them to the
 * thread's agent as a queued turn.
 */
export async function sendDrafts(
  client: ClientApi,
  store: LocalStore<readonly ReviewDraft[]>,
  thread: { id: ThreadId; workspaceId: WorkspaceId },
  keys: readonly string[],
): Promise<void> {
  const picked = new Set(keys);
  const drafts = store.get().filter((draft) => picked.has(draft.key) && isPending(draft));
  if (!drafts.length) return;
  const sending = new Set(drafts.map((draft) => draft.key));
  patch(store, sending, ({ error: _error, ...draft }) => ({ ...draft, state: "sending" }));
  try {
    const { sessionId, commentIds } = await record(client, store, thread, drafts);
    await review(client, {
      type: "review.sendToAgent",
      sessionId,
      threadId: thread.id,
      commentIds,
    });
    patch(store, sending, (draft) => ({ ...draft, state: "sent", anchor: "active" }));
  } catch (error) {
    const message = error instanceof Error ? error.message : actionErrorText(undefined);
    patch(store, sending, (draft) => ({ ...draft, state: "failed", error: message }));
  }
}

/** Mark a sent comment resolved (or open again); the daemon keeps the flag with the comment. */
export async function resolveDraft(
  client: ClientApi,
  store: LocalStore<readonly ReviewDraft[]>,
  key: string,
  resolved: boolean,
): Promise<void> {
  const draft = store.get().find((candidate) => candidate.key === key);
  if (!draft?.commentId || !draft.sessionId) return;
  const before = draft.state;
  const only = new Set([key]);
  patch(store, only, ({ error: _error, ...d }) => ({ ...d, state: "resolving" }));
  try {
    await review(client, {
      type: "review.resolve",
      sessionId: draft.sessionId,
      commentId: draft.commentId,
      resolved,
    });
    patch(store, only, (d) => ({ ...d, state: resolved ? "resolved" : "sent" }));
  } catch (error) {
    const message = error instanceof Error ? error.message : actionErrorText(undefined);
    patch(store, only, (d) => ({ ...d, state: before, error: message }));
  }
}

/**
 * Read back the daemon's sessions and comments for this thread: resolved elsewhere, outdated
 * by a later edit, or addressed and waiting for review. Comments it no longer has keep their
 * last known state.
 */
export async function refreshDrafts(
  client: ClientApi,
  store: LocalStore<readonly ReviewDraft[]>,
  threadId: string,
): Promise<ReviewSession | null> {
  const sessions = new Map<string, ReviewSession>();
  let sessionCursor = "";
  // Discover daemon sessions as well as this device's comments. Bound each refresh.
  for (let page = 0; page < 10; page++) {
    const data = await review(client, {
      type: "review.list",
      threadId: ThreadIdSchema.parse(threadId),
      cursor: sessionCursor,
      limit: 20,
    });
    for (const session of data.sessions ?? [])
      if (session.source.threadId === threadId) sessions.set(session.id, session);
    if (!data.nextCursor) break;
    sessionCursor = data.nextCursor;
  }
  const ids = new Set([
    ...sessions.keys(),
    ...store
      .get()
      .filter((draft) => draft.threadId === threadId && draft.sessionId)
      .map((draft) => draft.sessionId ?? ""),
  ]);
  const held = new Map<string, ReviewComment>();
  for (const sessionId of [...ids].slice(0, 20)) {
    let cursor = "";
    for (let page = 0; page < 10; page++) {
      const data = await review(client, { type: "review.list", sessionId, cursor, limit: 20 });
      for (const comment of data.comments ?? []) held.set(comment.id, comment);
      if (!data.nextCursor) break;
      cursor = data.nextCursor;
    }
  }
  const newest = [...sessions.values()].reduce<ReviewSession | null>(
    (best, session) => (!best || session.createdAt >= best.createdAt ? session : best),
    null,
  );
  if (!held.size) return newest;
  store.set((drafts) => {
    const known = new Set(drafts.flatMap((draft) => (draft.commentId ? [draft.commentId] : [])));
    const updated = drafts.map((draft) => {
      const comment = draft.commentId ? held.get(draft.commentId) : undefined;
      if (!comment || draft.state === "sending" || draft.state === "resolving") return draft;
      const remoteState =
        sessions.get(comment.sessionId)?.status === "changes-requested" ? "sent" : "draft";
      const state: DraftState = comment.resolved
        ? "resolved"
        : draft.state === "resolved" || draft.state === "draft"
          ? remoteState
          : draft.state;
      return { ...draft, state, anchor: comment.anchor.state };
    });
    const usedKeys = new Set(updated.map((draft) => draft.key));
    for (const comment of held.values()) {
      if (known.has(comment.id)) continue;
      if (updated.length >= 400) break;
      const position = comment.anchor.position;
      updated.push({
        key: usedKeys.has(draftKey(threadId, position.file, position.side, position.start))
          ? `remote:${comment.sessionId}:${comment.id}`
          : draftKey(threadId, position.file, position.side, position.start),
        threadId,
        file: position.file,
        side: position.side,
        line: position.start,
        ...(position.end === position.start ? {} : { end: position.end }),
        text: comment.text,
        ...(comment.suggestion === undefined ? {} : { suggestion: comment.suggestion }),
        state: comment.resolved
          ? "resolved"
          : sessions.get(comment.sessionId)?.status === "changes-requested"
            ? "sent"
            : "draft",
        commentId: comment.id,
        sessionId: comment.sessionId,
        anchor: comment.anchor.state,
        createdAt: sessions.get(comment.sessionId)?.createdAt ?? 0,
      });
      usedKeys.add(updated.at(-1)?.key ?? "");
    }
    return updated;
  });
  return newest;
}
