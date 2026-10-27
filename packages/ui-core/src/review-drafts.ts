import { ThreadId as ThreadIdSchema } from "@ace/protocol";
import type { ClientApi } from "@ace/client";
import { actionErrorText } from "./action-errors.ts";
import type {
  CommandPayload,
  ReviewComment,
  ReviewData,
  ReviewSession,
  ReviewFingerprint,
  ReviewSource,
  ThreadId,
  WorkspaceId,
} from "@ace/protocol";

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
 *
 * Shared by the web's Changes tab and the native apps' Changes sheet: each keeps the drafts in
 * its own `DraftStore` (a page's local store, a phone's kept value).
 */

/** Where drafts are held: read them all, or replace them from the previous list. */
export interface DraftStore {
  get(): readonly ReviewDraft[];
  set(next: (previous: readonly ReviewDraft[]) => readonly ReviewDraft[]): void;
}

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
  /** Displayed selection, checked against the daemon snapshot before recording. */
  fingerprint?: ReviewFingerprint | undefined;
  source?: ReviewSource | undefined;
  /**
   * The `review.comment` command sent for it whose answer never arrived, and the session it
   * went to: a resend reuses the id, so the daemon answers with that comment, not a second.
   */
  commentCommand?: { id: string; sessionId: string } | undefined;
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
  store: DraftStore,
  draft: Omit<ReviewDraft, "key" | "state"> & { key?: string },
): void {
  const key =
    draft.key ??
    `${draftKey(draft.threadId, draft.file, draft.side, draft.line)}\u0000${draft.createdAt}`;
  store.set((drafts) => [
    ...drafts.filter((entry) => entry.key !== key),
    { ...draft, key, state: "draft" },
  ]);
}
export function discardDraft(store: DraftStore, key: string): void {
  store.set((drafts) => drafts.filter((draft) => draft.key !== key));
}

/** The daemon answered and refused: unlike a lost answer, nothing happened. */
export class ReviewRefusal extends Error {}

/**
 * A review command, under `id` when given (the same id answers the same result); a refusal
 * becomes a `ReviewRefusal` saying what happened and what to do.
 */
export async function review(
  client: Pick<ClientApi, "command">,
  payload: CommandPayload,
  id?: string,
): Promise<ReviewData> {
  const result = await (id === undefined
    ? client.command(payload)
    : client.command(payload, undefined, id));
  if (!result.ok) throw new ReviewRefusal(actionErrorText(result.error));
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
  store: DraftStore,
  keys: ReadonlySet<string>,
  change: (draft: ReviewDraft) => ReviewDraft,
) {
  store.set((drafts) => drafts.map((draft) => (keys.has(draft.key) ? change(draft) : draft)));
}

/** The session a draft is (or may already be) recorded in. */
export const recordedIn = (draft: ReviewDraft) =>
  draft.commentId ? draft.sessionId : draft.commentCommand?.sessionId;

/**
 * Record drafts with the daemon: open (or reuse) the review session for the thread's working
 * tree and add each comment on its lines, unless it is already there. Drafts remember their
 * comment and session, and a comment whose answer was lost remembers its command, so doing it
 * again records nothing twice. `newId` names each new comment command.
 */
export async function record(
  client: Pick<ClientApi, "command">,
  store: DraftStore,
  thread: { id: ThreadId; workspaceId: WorkspaceId },
  drafts: readonly ReviewDraft[],
  newId: () => string,
): Promise<{ sessionId: string; commentIds: string[] }> {
  if (drafts.some((draft) => (!draft.commentId || !draft.sessionId) && !draft.fingerprint))
    throw new Error(
      "These saved lines have no review snapshot: select them again in the current diff.",
    );
  const previous = drafts[0] && recordedIn(drafts[0]);
  const reuse = previous && drafts.every((draft) => recordedIn(draft) === previous);
  const forget = () =>
    patch(store, new Set(drafts.map((draft) => draft.key)), ({ commentCommand: _, ...d }) => d);
  const opened = reuse
    ? await review(client, {
        type: "review.list",
        sessionId: previous,
        cursor: "",
        limit: 1,
      }).catch((error: unknown) => {
        // The session is gone: the next send opens a new one.
        if (error instanceof ReviewRefusal) forget();
        throw error;
      })
    : await review(client, {
        type: "review.open",
        source: drafts[0]?.source ?? {
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
    // Kept before it goes, so a resend after a lost answer (or a relaunch) reuses it.
    const command =
      draft.commentCommand?.sessionId === sessionId
        ? draft.commentCommand
        : { id: newId(), sessionId };
    const only = new Set([draft.key]);
    patch(store, only, (d) => ({ ...d, commentCommand: command }));
    const { comment } = await review(
      client,
      {
        type: "review.comment",
        sessionId,
        position: positionOf(draft),
        ...(draft.fingerprint ? { expectedFingerprint: draft.fingerprint } : {}),
        text: draft.text,
        ...(draft.suggestion === undefined ? {} : { suggestion: draft.suggestion }),
      },
      command.id,
    ).catch((error: unknown) => {
      // Refused: nothing was recorded, so a retry asks afresh.
      if (error instanceof ReviewRefusal) patch(store, only, ({ commentCommand: _, ...d }) => d);
      throw error;
    });
    if (!comment) throw new Error("The daemon didn't record the comment: try again.");
    const commentId = comment.id;
    commentIds.push(commentId);
    // A refresh that ran while this comment was being recorded may already have added the
    // daemon's copy of it as a comment from elsewhere: this draft is that comment, so the copy goes.
    store.set((held) =>
      held.flatMap((d) =>
        d.key === draft.key
          ? [{ ...d, commentId, sessionId, source: opened.session?.source, commentCommand: undefined }]
          : d.commentId === commentId
            ? []
            : [d],
      ),
    );
  }
  return { sessionId, commentIds };
}

/**
 * Review mode (ADR 0038): record the comments, then ask the daemon to deliver them to the
 * thread's agent as a queued turn.
 */
export async function sendDrafts(
  client: Pick<ClientApi, "command">,
  store: DraftStore,
  thread: { id: ThreadId; workspaceId: WorkspaceId },
  keys: readonly string[],
  newId: () => string,
): Promise<void> {
  const picked = new Set(keys);
  const drafts = store.get().filter((draft) => picked.has(draft.key) && isPending(draft));
  if (!drafts.length) return;
  const sending = new Set(drafts.map((draft) => draft.key));
  patch(store, sending, ({ error: _error, ...draft }) => ({ ...draft, state: "sending" }));
  try {
    // Recorded comments keep their original session and immutable revision on bulk sends.
    const groups = new Map<string, ReviewDraft[]>();
    for (const draft of drafts) {
      const identity = recordedIn(draft) ?? JSON.stringify(draft.source ?? null);
      const group = groups.get(identity) ?? [];
      group.push(draft);
      groups.set(identity, group);
    }
    for (const group of groups.values()) {
      const { sessionId, commentIds } = await record(client, store, thread, group, newId);
      // The public review command admits at most twenty comments per queued turn.
      for (let offset = 0; offset < commentIds.length; offset += 20) {
        await review(client, {
          type: "review.sendToAgent",
          sessionId,
          threadId: thread.id,
          commentIds: commentIds.slice(offset, offset + 20),
        });
        const delivered = new Set(group.slice(offset, offset + 20).map((draft) => draft.key));
        patch(store, delivered, (draft) => ({ ...draft, state: "sent", anchor: "active" }));
        for (const key of delivered) sending.delete(key);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : actionErrorText(undefined);
    patch(store, sending, (draft) => ({ ...draft, state: "failed", error: message }));
  }
}

/** Mark a sent comment resolved (or open again); the daemon keeps the flag with the comment. */
export async function resolveDraft(
  client: Pick<ClientApi, "command">,
  store: DraftStore,
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
  client: Pick<ClientApi, "command">,
  store: DraftStore,
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
        fingerprint: comment.originalAnchor.fingerprint,
        source: sessions.get(comment.sessionId)?.source,
        createdAt: sessions.get(comment.sessionId)?.createdAt ?? 0,
      });
      usedKeys.add(updated.at(-1)?.key ?? "");
    }
    return updated;
  });
  return newest;
}
