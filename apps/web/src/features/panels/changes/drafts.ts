import type { ClientApi } from "@ace/client";
import type { CommandPayload, ReviewData, ThreadId, WorkspaceId } from "@ace/protocol";
import type { LocalStore } from "../store.ts";

/** A line comment written in the Changes tab. A draft until it is sent to the agent. */
export interface ReviewDraft {
  key: string;
  threadId: string;
  file: string;
  side: "old" | "new";
  line: number;
  text: string;
  state: "draft" | "sending" | "sent" | "failed";
  error?: string;
  /** Set once the daemon has recorded it, so a retry does not record it twice. */
  commentId?: string;
  createdAt: number;
}

export const draftKey = (threadId: string, file: string, side: "old" | "new", line: number) =>
  `${threadId}\u0000${file}\u0000${side}\u0000${line}`;

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
  if (!result.ok) throw new Error(result.error ?? "The daemon refused the review command");
  return result.review ?? {};
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
  const mark = (state: ReviewDraft["state"], error?: string) =>
    store.set((drafts) =>
      drafts.map((draft) => {
        if (!picked.has(draft.key)) return draft;
        const { error: _previous, ...rest } = draft;
        return error ? { ...rest, state, error } : { ...rest, state };
      }),
    );
  const drafts = store.get().filter((draft) => picked.has(draft.key));
  if (!drafts.length) return;
  mark("sending");
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
    if (!sessionId) throw new Error("The daemon did not open a review session");
    const commentIds: string[] = [];
    for (const draft of drafts) {
      if (draft.commentId) {
        commentIds.push(draft.commentId);
        continue;
      }
      const { comment } = await review(client, {
        type: "review.comment",
        sessionId,
        position: { file: draft.file, side: draft.side, start: draft.line, end: draft.line },
        text: draft.text,
      });
      if (!comment) throw new Error("The daemon did not record the comment");
      const commentId = comment.id;
      commentIds.push(commentId);
      store.set((all) => all.map((d) => (d.key === draft.key ? { ...d, commentId } : d)));
    }
    await review(client, {
      type: "review.sendToAgent",
      sessionId,
      threadId: thread.id,
      commentIds,
    });
    mark("sent");
  } catch (error) {
    mark("failed", error instanceof Error ? error.message : "Sending failed");
  }
}
