import { z } from "zod";
import { ThreadId, WorkspaceId } from "./ids.ts";

const id = z.string().min(1).max(128);
const text = z.string().min(1).max(4096);
const line = z.number().int().positive().max(10_000_000);
export const ReviewPath = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.includes("\\") &&
      [...path].every((char) => char.charCodeAt(0) >= 32) &&
      !/^[A-Za-z]:/.test(path) &&
      path.split("/").every((part) => part !== ".." && part !== "." && part !== ""),
    "Expected a safe repository-relative path",
  );
export const ReviewRevision = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("working-tree") }),
  z.object({
    kind: z.literal("commit"),
    ref: z
      .string()
      .min(1)
      .max(256)
      .refine((s) => !s.startsWith("-") && !s.includes("\0")),
  }),
  z.object({ kind: z.literal("checkpoint"), id }),
]);
export type ReviewRevision = z.infer<typeof ReviewRevision>;
export const ReviewSource = z.object({
  workspaceId: WorkspaceId,
  threadId: ThreadId.optional(),
  from: ReviewRevision,
  to: ReviewRevision,
});
export type ReviewSource = z.infer<typeof ReviewSource>;
/** Host-only execution identity; clients cannot choose a filesystem root. */
export const ReviewExecutionSource = ReviewSource.extend({ worktree: z.string().min(1).max(4096) });
export type ReviewExecutionSource = z.infer<typeof ReviewExecutionSource>;
export const ReviewExecutionTarget = z.object({
  threadId: ThreadId,
  workspaceId: WorkspaceId,
  worktree: z.string().min(1).max(4096),
});
export type ReviewExecutionTarget = z.infer<typeof ReviewExecutionTarget>;
export const ReviewPosition = z
  .object({ file: ReviewPath, side: z.enum(["old", "new"]), start: line, end: line })
  .refine((p) => p.end >= p.start && p.end - p.start < 100, "Invalid line range");
export type ReviewPosition = z.infer<typeof ReviewPosition>;
const context = z.array(z.string().max(8192)).max(3);
export const ReviewFingerprint = z
  .object({
    before: context,
    lines: z.array(z.string().max(8192)).min(1).max(100),
    after: context,
    noFinalNewline: z.literal(true).optional(),
  })
  .refine(
    (f) => [...f.before, ...f.lines, ...f.after].reduce((n, s) => n + s.length, 0) <= 8192,
    "Fingerprint too large",
  );
export type ReviewFingerprint = z.infer<typeof ReviewFingerprint>;
export const ReviewAnchor = z
  .object({
    position: ReviewPosition,
    revision: ReviewRevision,
    fingerprint: ReviewFingerprint,
    state: z.enum(["active", "outdated", "addressed-pending-review"]),
  })
  .refine(
    (anchor) => anchor.position.end - anchor.position.start + 1 === anchor.fingerprint.lines.length,
    "Fingerprint must cover the selected range",
  );
export type ReviewAnchor = z.infer<typeof ReviewAnchor>;
export const ReviewComment = z.object({
  id,
  sessionId: id,
  anchor: ReviewAnchor,
  originalAnchor: ReviewAnchor,
  text,
  suggestion: z.string().max(8192).optional(),
  resolved: z.boolean(),
});
export type ReviewComment = z.infer<typeof ReviewComment>;
export const ReviewReply = z.object({ id, commentId: id, text });
export type ReviewReply = z.infer<typeof ReviewReply>;
export const ReviewSession = z.object({
  id,
  source: ReviewSource,
  status: z.enum(["open", "changes-requested", "approved"]),
  createdAt: z.number().int().nonnegative(),
});
export type ReviewSession = z.infer<typeof ReviewSession>;
export const ReviewerComment = z
  .object({ position: ReviewPosition, text, suggestion: z.string().max(8192).optional() })
  .strict();
export const ReviewerOutput = z.object({ comments: z.array(ReviewerComment).max(100) }).strict();
export type ReviewerOutput = z.infer<typeof ReviewerOutput>;
export const ReviewFixIntent = z.object({
  kind: z.literal("review-fix"),
  requestId: id,
  sessionId: id,
  threadId: ThreadId,
  source: ReviewExecutionSource,
  comments: z
    .array(
      z.object({
        id,
        position: ReviewPosition,
        text,
        suggestion: z.string().max(8192).optional(),
        excerpt: z.string().max(2048),
      }),
    )
    .min(1)
    .max(20),
});
export type ReviewFixIntent = z.infer<typeof ReviewFixIntent>;
export const ReviewReviewerIntent = z.object({
  kind: z.literal("review-run"),
  requestId: id,
  sessionId: id,
  threadId: ThreadId,
  source: ReviewExecutionSource,
  diff: z.string().max(65_536),
});
export type ReviewReviewerIntent = z.infer<typeof ReviewReviewerIntent>;
export const ReviewCommands = [
  z.object({ type: z.literal("review.open"), source: ReviewSource }),
  z.object({
    type: z.literal("review.comment"),
    sessionId: id,
    position: ReviewPosition,
    text,
    suggestion: z.string().max(8192).optional(),
  }),
  z.object({ type: z.literal("review.reply"), sessionId: id, commentId: id, text }),
  z.object({
    type: z.literal("review.resolve"),
    sessionId: id,
    commentId: id,
    resolved: z.boolean(),
  }),
  z.object({ type: z.literal("review.applySuggestion"), sessionId: id, commentId: id }),
  z.object({
    type: z.literal("review.sendToAgent"),
    sessionId: id,
    threadId: ThreadId,
    commentIds: z.array(id).min(1).max(20),
  }),
  z.object({ type: z.literal("review.askReviewer"), sessionId: id, threadId: ThreadId }),
  z.object({
    type: z.literal("review.refresh"),
    sessionId: id,
    from: ReviewRevision,
    to: ReviewRevision,
  }),
  z.object({ type: z.literal("review.status"), sessionId: id, status: ReviewSession.shape.status }),
  z.object({
    type: z.literal("review.list"),
    sessionId: id.optional(),
    commentId: id.optional(),
    cursor: z.string().max(128).default(""),
    limit: z.number().int().min(1).max(20).default(20),
  }),
] as const;
export const ReviewCommand = z.discriminatedUnion("type", ReviewCommands);
export type ReviewCommand = z.infer<typeof ReviewCommand>;
export const ReviewData = z.object({
  session: ReviewSession.optional(),
  comment: ReviewComment.optional(),
  reply: ReviewReply.optional(),
  sessions: z.array(ReviewSession).max(20).optional(),
  comments: z.array(ReviewComment).max(20).optional(),
  replies: z.array(ReviewReply).max(20).optional(),
  nextCursor: z.string().optional(),
  intentId: id.optional(),
});
export type ReviewData = z.infer<typeof ReviewData>;
