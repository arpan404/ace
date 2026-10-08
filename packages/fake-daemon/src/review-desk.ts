import type {
  CommandResult,
  ReviewCommand,
  ReviewComment,
  ReviewSession,
  ReviewReply,
} from "@ace/protocol";

type Result = Omit<CommandResult, "commandId">;

/**
 * Review mode (ADR 0038) as far as the client can see it: sessions, line comments, resolving and
 * "Send to agent". The real service anchors comments against git checkpoints; the fake keeps
 * them in memory and delivers sent comments to the thread as a user message, which is what an
 * engine executor does from the transcript's point of view.
 */
export class FakeReviewDesk {
  private roots = new Map<string, string>();
  private sessions = new Map<string, ReviewSession>();
  private replies = new Map<string, ReviewReply>();
  private notes = new Map<string, ReviewComment>();
  private sent = new Set<string>();
  private counter = 0;
  private clock: () => number;
  private files: {
    reviewTarget(threadId: string): { workspaceId: string; worktree: string } | undefined;
    reviewLines(threadId: string, path: string, start: number, end: number): string[];
    applyReviewSuggestion(threadId: string, comment: ReviewComment): boolean;
  };
  private deliver: (threadId: string, text: string, requestId: string) => Result;
  constructor(
    clock: () => number,
    deliver: (threadId: string, text: string, requestId: string) => Result,
    files: FakeReviewDesk["files"],
  ) {
    this.clock = clock;
    this.deliver = deliver;
    this.files = files;
  }
  /** Comments the daemon holds, oldest first, with whether each was sent to an agent. */
  comments(): (ReviewComment & { sent: boolean })[] {
    return [...this.notes.values()].map((comment) =>
      Object.assign({}, comment, { sent: this.sent.has(comment.id) }),
    );
  }
  execute(payload: ReviewCommand, requestId: string): Result {
    switch (payload.type) {
      case "review.open": {
        const target = payload.source.threadId
          ? this.files.reviewTarget(payload.source.threadId)
          : undefined;
        if (
          payload.source.threadId &&
          (!target || target.workspaceId !== payload.source.workspaceId)
        )
          return { ok: false, error: "review_workspace_not_found" };
        for (const session of this.sessions.values())
          if (
            JSON.stringify(session.source) === JSON.stringify(payload.source) &&
            this.roots.get(session.id) === target?.worktree
          )
            return { ok: true, review: { session } };
        if (this.sessions.size >= 400) return { ok: false, error: "review_limit" };
        const session: ReviewSession = {
          id: `review-${++this.counter}`,
          source: payload.source,
          status: "open",
          createdAt: this.clock(),
        };
        this.sessions.set(session.id, session);
        if (target) this.roots.set(session.id, target.worktree);
        return { ok: true, review: { session } };
      }
      case "review.comment": {
        const session = this.sessions.get(payload.sessionId);
        if (!session) return { ok: false, error: "review_not_found" };
        if (this.notes.size >= 2000) return { ok: false, error: "review_limit" };
        const lines = session.source.threadId
          ? this.files.reviewLines(
              session.source.threadId,
              payload.position.file,
              payload.position.start,
              payload.position.end,
            )
          : [];
        const anchor = {
          position: payload.position,
          revision: session.source.to,
          fingerprint: { before: [], lines, after: [] },
          state: "active" as const,
        };
        const comment: ReviewComment = {
          id: `comment-${++this.counter}`,
          sessionId: session.id,
          anchor,
          originalAnchor: anchor,
          text: payload.text,
          resolved: false,
          ...(payload.suggestion === undefined ? {} : { suggestion: payload.suggestion }),
        };
        this.notes.set(comment.id, comment);
        return { ok: true, review: { comment } };
      }
      case "review.sendToAgent": {
        const session = this.sessions.get(payload.sessionId);
        if (!session) return { ok: false, error: "review_not_found" };
        const target = this.files.reviewTarget(payload.threadId);
        if (
          !target ||
          target.workspaceId !== session.source.workspaceId ||
          target.worktree !== this.roots.get(session.id)
        )
          return { ok: false, error: "review_target_mismatch" };
        const picked = payload.commentIds.map((id) => this.notes.get(id));
        if (picked.some((comment) => !comment || comment.sessionId !== payload.sessionId))
          return { ok: false, error: "review_not_found" };
        const comments = picked.filter((comment) => comment !== undefined);
        if (comments.some((comment) => comment.resolved || comment.anchor.state === "outdated"))
          return { ok: false, error: "review_comment_unavailable" };
        const delivered = this.deliver(payload.threadId, describe(comments), requestId);
        if (!delivered.ok) return { ok: false, error: "review_queue_rejected" };
        for (const comment of comments) this.sent.add(comment.id);
        const next = { ...session, status: "changes-requested" as const };
        this.sessions.set(next.id, next);
        return { ok: true, review: { session: next, intentId: requestId } };
      }
      case "review.resolve": {
        const comment = this.notes.get(payload.commentId);
        if (!comment || comment.sessionId !== payload.sessionId)
          return { ok: false, error: "review_not_found" };
        const next = { ...comment, resolved: payload.resolved };
        this.notes.set(comment.id, next);
        return { ok: true, review: { comment: next } };
      }
      case "review.list": {
        if (payload.commentId) {
          const comment = this.notes.get(payload.commentId);
          if (!comment || comment.sessionId !== payload.sessionId)
            return { ok: false, error: "review_not_found" };
          const replies = [...this.replies.values()]
            .filter((reply) => reply.commentId === payload.commentId && reply.id > payload.cursor)
            .toSorted((a, b) => a.id.localeCompare(b.id))
            .slice(0, payload.limit);
          return { ok: true, review: { replies, nextCursor: replies.at(-1)?.id ?? "" } };
        }
        if (!payload.sessionId) {
          const sessions = [...this.sessions.values()]
            .filter(
              (session) =>
                session.id > payload.cursor &&
                (!payload.threadId || session.source.threadId === payload.threadId),
            )
            .toSorted((a, b) => a.id.localeCompare(b.id))
            .slice(0, payload.limit);
          return { ok: true, review: { sessions, nextCursor: sessions.at(-1)?.id ?? "" } };
        }
        const session = this.sessions.get(payload.sessionId);
        if (!session) return { ok: false, error: "review_not_found" };
        const comments = [...this.notes.values()]
          .filter(
            (comment) => comment.sessionId === payload.sessionId && comment.id > payload.cursor,
          )
          .toSorted((a, b) => a.id.localeCompare(b.id))
          .slice(0, payload.limit);
        return { ok: true, review: { session, comments, nextCursor: comments.at(-1)?.id ?? "" } };
      }
      case "review.reply": {
        const comment = this.notes.get(payload.commentId);
        if (!comment || comment.sessionId !== payload.sessionId)
          return { ok: false, error: "review_not_found" };
        if (this.replies.size >= 2000) return { ok: false, error: "review_limit" };
        const reply = { id: `reply-${++this.counter}`, commentId: comment.id, text: payload.text };
        this.replies.set(reply.id, reply);
        return { ok: true, review: { reply } };
      }
      case "review.applySuggestion": {
        const comment = this.notes.get(payload.commentId);
        const session = this.sessions.get(payload.sessionId);
        if (!comment || !session || comment.sessionId !== session.id)
          return { ok: false, error: "review_not_found" };
        if (
          session.source.threadId &&
          this.files.reviewTarget(session.source.threadId)?.worktree !== this.roots.get(session.id)
        )
          return { ok: false, error: "review_target_mismatch" };
        if (
          comment.resolved ||
          comment.anchor.state === "outdated" ||
          comment.anchor.position.side !== "new" ||
          comment.suggestion === undefined
        )
          return { ok: false, error: "review_suggestion_unavailable" };
        if (
          !session.source.threadId ||
          !this.files.applyReviewSuggestion(session.source.threadId, comment)
        )
          return { ok: false, error: "review_suggestion_conflict" };
        const next: ReviewComment = {
          ...comment,
          anchor: { ...comment.anchor, state: "addressed-pending-review" },
        };
        this.notes.set(next.id, next);
        return { ok: true, review: { comment: next } };
      }
      case "review.askReviewer":
        return { ok: false, error: "review_reviewer_unavailable" };
      case "review.status": {
        const session = this.sessions.get(payload.sessionId);
        if (!session) return { ok: false, error: "review_not_found" };
        const next = { ...session, status: payload.status };
        this.sessions.set(next.id, next);
        return { ok: true, review: { session: next } };
      }
      default:
        return { ok: false, error: "unsupported_by_fake_daemon" };
    }
  }
}

function describe(comments: readonly ReviewComment[]): string {
  const lines = comments.map(({ anchor: { position }, text }) => {
    const range =
      position.start === position.end ? `${position.start}` : `${position.start}-${position.end}`;
    return `- ${position.file}:${range} (${position.side} side): ${text}`;
  });
  return [
    "Review comments to address:",
    ...lines,
    JSON.stringify({
      comments: comments.map((comment) => ({
        position: comment.anchor.position,
        text: comment.text,
        suggestion: comment.suggestion,
        excerpt: comment.anchor.fingerprint.lines.join("\n"),
      })),
    }),
  ].join("\n");
}
