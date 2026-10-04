import type { CommandResult, ReviewCommand, ReviewComment, ReviewSession } from "@ace/protocol";

type Result = Omit<CommandResult, "commandId">;

/**
 * Review mode (ADR 0038) as far as the client can see it: sessions, line comments, resolving and
 * "Send to agent". The real service anchors comments against git checkpoints; the fake keeps
 * them in memory and delivers sent comments to the thread as a user message, which is what an
 * engine executor does from the transcript's point of view.
 */
export class FakeReviewDesk {
  private sessions = new Map<string, ReviewSession>();
  private notes = new Map<string, ReviewComment>();
  private sent = new Set<string>();
  private counter = 0;
  private clock: () => number;
  private deliver: (threadId: string, text: string) => void;
  constructor(clock: () => number, deliver: (threadId: string, text: string) => void) {
    this.clock = clock;
    this.deliver = deliver;
  }
  /** Comments the daemon holds, oldest first, with whether each was sent to an agent. */
  comments(): (ReviewComment & { sent: boolean })[] {
    return [...this.notes.values()].map((comment) =>
      Object.assign({}, comment, { sent: this.sent.has(comment.id) }),
    );
  }
  execute(payload: ReviewCommand): Result {
    switch (payload.type) {
      case "review.open": {
        for (const session of this.sessions.values())
          if (JSON.stringify(session.source) === JSON.stringify(payload.source))
            return { ok: true, review: { session } };
        const session: ReviewSession = {
          id: `review-${++this.counter}`,
          source: payload.source,
          status: "open",
          createdAt: this.clock(),
        };
        this.sessions.set(session.id, session);
        return { ok: true, review: { session } };
      }
      case "review.comment": {
        const session = this.sessions.get(payload.sessionId);
        if (!session) return { ok: false, error: "not_found" };
        const lines = payload.position.end - payload.position.start + 1;
        const anchor = {
          position: payload.position,
          revision: session.source.to,
          fingerprint: { before: [], lines: Array.from({ length: lines }, () => ""), after: [] },
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
        const picked = payload.commentIds.map((id) => this.notes.get(id));
        if (picked.some((comment) => !comment || comment.sessionId !== payload.sessionId))
          return { ok: false, error: "not_found" };
        const comments = picked.filter((comment) => comment !== undefined);
        if (comments.some((comment) => comment.resolved || comment.anchor.state === "outdated"))
          return { ok: false, error: "not_actionable" };
        for (const comment of comments) this.sent.add(comment.id);
        this.deliver(payload.threadId, describe(comments));
        return { ok: true, review: { intentId: `review-fix-${++this.counter}` } };
      }
      case "review.resolve": {
        const comment = this.notes.get(payload.commentId);
        if (!comment || comment.sessionId !== payload.sessionId)
          return { ok: false, error: "not_found" };
        const next = { ...comment, resolved: payload.resolved };
        this.notes.set(comment.id, next);
        return { ok: true, review: { comment: next } };
      }
      case "review.list": {
        const comments = [...this.notes.values()].filter(
          (comment) => !payload.sessionId || comment.sessionId === payload.sessionId,
        );
        return { ok: true, review: { comments: comments.slice(0, payload.limit) } };
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
  return ["Review comments to address:", ...lines].join("\n");
}
