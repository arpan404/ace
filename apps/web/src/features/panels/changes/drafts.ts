import { refusalMessage } from "@/lib/daemon-command.ts";
import type { ClientApi } from "@ace/client";
import type {
  CommandPayload,
  ReviewComment,
  ReviewData,
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
  line: number;
  text: string;
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
  store.set((drafts) => [
    ...drafts.filter((existing) => existing.key !== key),
    { ...draft, key, state: "draft" },
  ]);
}
export function discardDraft(store: LocalStore<readonly ReviewDraft[]>, key: string): void {
  store.set((drafts) => drafts.filter((draft) => draft.key !== key));
}

async function review(client: ClientApi, payload: CommandPayload): Promise<ReviewData> {
  const result = await client.command(payload);
  if (!result.ok) throw new Error(refusal(result.error));
  return result.review ?? {};
}

const refusals: Record<string, string> = {
  not_found: "ace no longer has this review",
  not_actionable: "the comment is resolved or its lines are gone",
  unsupported_by_fake_daemon: "ace on this machine can't do that yet",
};
const refusal = (code: string | undefined) =>
  (code && refusals[code]) ?? refusalMessage(code ?? "unknown");

function patch(
  store: LocalStore<readonly ReviewDraft[]>,
  keys: ReadonlySet<string>,
  change: (draft: ReviewDraft) => ReviewDraft,
) {
  store.set((drafts) => drafts.map((draft) => (keys.has(draft.key) ? change(draft) : draft)));
}

/**
 * Review mode (ADR 0038): open (or reuse) the session for the thread's working tree, record
 * each comment on its line, then ask the daemon to deliver them to the thread's agent.
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
    const opened = await review(client, {
      type: "review.open",
      source: {
        workspaceId: thread.workspaceId,
        threadId: thread.id,
        from: { kind: "commit", ref: "HEAD" },
        to: { kind: "working-tree" },
      },
    });
    const sessionId = opened.session?.id;
    if (!sessionId) throw new Error("ace did not open a review session");
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
        position: { file: draft.file, side: draft.side, start: draft.line, end: draft.line },
        text: draft.text,
      });
      if (!comment) throw new Error("ace did not record the comment");
      const commentId = comment.id;
      commentIds.push(commentId);
      patch(store, new Set([draft.key]), (d) => ({ ...d, commentId, sessionId }));
    }
    await review(client, {
      type: "review.sendToAgent",
      sessionId,
      threadId: thread.id,
      commentIds,
    });
    patch(store, sending, (draft) => ({ ...draft, state: "sent", anchor: "active" }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "sending failed";
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
    const message = error instanceof Error ? error.message : "that didn't work";
    patch(store, only, (d) => ({ ...d, state: before, error: message }));
  }
}

/**
 * Read back what the daemon holds for this thread's sent comments: resolved elsewhere, outdated
 * by a later edit, or addressed and waiting for review. Comments it no longer has keep their
 * last known state.
 */
export async function refreshDrafts(
  client: ClientApi,
  store: LocalStore<readonly ReviewDraft[]>,
  threadId: string,
): Promise<void> {
  const sessions = new Set(
    store
      .get()
      .filter((draft) => draft.threadId === threadId && draft.sessionId && draft.commentId)
      .map((draft) => draft.sessionId ?? ""),
  );
  const held = new Map<string, ReviewComment>();
  for (const sessionId of sessions) {
    let cursor = "";
    // Bounded: 20 comments a page, at most 10 pages per session.
    for (let page = 0; page < 10; page++) {
      const data = await review(client, { type: "review.list", sessionId, cursor, limit: 20 });
      for (const comment of data.comments ?? []) held.set(comment.id, comment);
      if (!data.nextCursor) break;
      cursor = data.nextCursor;
    }
  }
  if (!held.size) return;
  store.set((drafts) =>
    drafts.map((draft) => {
      const comment = draft.commentId ? held.get(draft.commentId) : undefined;
      if (!comment || draft.state === "sending" || draft.state === "resolving") return draft;
      const state: DraftState = comment.resolved
        ? "resolved"
        : draft.state === "resolved"
          ? "sent"
          : draft.state;
      return state === draft.state && comment.anchor.state === draft.anchor
        ? draft
        : { ...draft, state, anchor: comment.anchor.state };
    }),
  );
}
