import {
  ReviewFixIntent,
  ReviewerOutput,
  type ReviewComment,
  type ReviewReviewerIntent,
  type ReviewExecutionSource,
  type ThreadId,
} from "@ace/protocol";

export interface ReviewExecutor {
  /** Persist acceptance before returning; deduplicate requestId across retries. */
  fix(intent: ReviewFixIntent, signal: AbortSignal): Promise<void>;
  review(intent: ReviewReviewerIntent, signal: AbortSignal): Promise<unknown>;
}
export function buildFixIntent(
  requestId: string,
  sessionId: string,
  threadId: ThreadId,
  comments: ReviewComment[],
  source: ReviewExecutionSource,
): ReviewFixIntent {
  if (new Set(comments.map((c) => c.id)).size !== comments.length)
    throw new Error("review_duplicate_selection");
  if (
    comments.some((c) => c.sessionId !== sessionId || c.resolved || c.anchor.state === "outdated")
  )
    throw new Error("review_comment_unavailable");
  const intent = ReviewFixIntent.parse({
    kind: "review-fix",
    requestId,
    sessionId,
    threadId,
    source,
    comments: comments.map((c) => ({
      id: c.id,
      position: c.anchor.position,
      text: c.text,
      ...(c.suggestion === undefined ? {} : { suggestion: c.suggestion }),
      excerpt: [
        ...c.anchor.fingerprint.before,
        ...c.anchor.fingerprint.lines,
        ...c.anchor.fingerprint.after,
      ]
        .join("\n")
        .slice(0, 2048),
    })),
  });
  if (Buffer.byteLength(JSON.stringify(intent)) > 65_536) throw new Error("review_fix_too_large");
  return intent;
}
export function parseReviewerOutput(output: unknown): ReviewerOutput {
  return ReviewerOutput.parse(output);
}
