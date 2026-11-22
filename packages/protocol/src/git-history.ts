import { z } from "zod";
import { ThreadId } from "./ids.ts";
import { ReviewPath } from "./review.ts";

/** A full Git commit object id (SHA-1 or SHA-256). */
export const CommitSha = z.string().regex(/^[0-9a-f]{40,64}$/);
export type CommitSha = z.infer<typeof CommitSha>;

/** Maximum commits returned by a single `git.log` page. */
export const gitLogMaxLimit = 100;
/** Byte cap for one `git.log` read from Git. */
export const gitLogMaxBytes = 256 * 1024;
/** Maximum lines returned by a single `git.blame` range read. */
export const gitBlameMaxLines = 500;
/** Byte cap for one `git.blame` read from Git. */
export const gitBlameMaxBytes = 512 * 1024;

const lineNumber = z.number().int().positive().max(10_000_000);

export const GitLogEntry = z.object({
  sha: CommitSha,
  shortSha: z.string().min(7).max(16),
  subject: z.string().max(4096),
  authorName: z.string().max(512),
  authorEmail: z.string().max(512),
  authoredAt: z.number().int().nonnegative(),
  /** The file's repository-relative path at this commit (following renames). */
  path: ReviewPath,
  /** When this commit renamed the file, its previous repository-relative path. */
  previousPath: ReviewPath.optional(),
});
export type GitLogEntry = z.infer<typeof GitLogEntry>;

export const GitBlameCommit = z.object({
  sha: CommitSha,
  shortSha: z.string().min(7).max(16),
  subject: z.string().max(4096),
  authorName: z.string().max(512),
  authorEmail: z.string().max(512),
  authoredAt: z.number().int().nonnegative(),
  path: ReviewPath.optional(),
});
export type GitBlameCommit = z.infer<typeof GitBlameCommit>;

export const GitBlameLine = z.object({
  line: lineNumber,
  /** The commit that last changed this line (null is kept for older daemons' uncommitted lines). */
  sha: CommitSha.nullable(),
});
export type GitBlameLine = z.infer<typeof GitBlameLine>;

/**
 * Where a file's next page of history resumes: the same walk from `tip` for `path` as named
 * there, after the `shown` rows already shown. A page whose tip is gone is refused
 * (`git_history_changed`).
 */
export const GitLogCursor = z.object({
  tip: CommitSha,
  path: ReviewPath,
  shown: z.number().int().min(1).max(10_000),
});
export type GitLogCursor = z.infer<typeof GitLogCursor>;

export const GitHistoryOperations = [
  /**
   * File-scoped commit history in the thread's checkout, following renames (`git log --follow`).
   * The first page walks from HEAD; a later one resumes that walk at the `next` cursor.
   * Bounded by `gitLogMaxLimit` entries, `gitLogMaxBytes` bytes and a work budget.
   */
  z.object({
    op: z.literal("git.log"),
    threadId: ThreadId,
    path: ReviewPath,
    cursor: GitLogCursor.optional(),
    limit: z.number().int().min(1).max(gitLogMaxLimit).default(50),
  }),
  /**
   * File-scoped blame of a bounded 1-based inclusive line range at `commit` (HEAD when left
   * out, resolved once and returned as `head`). Lines are the file's lines at that commit.
   */
  z
    .object({
      op: z.literal("git.blame"),
      threadId: ThreadId,
      path: ReviewPath,
      commit: CommitSha.optional(),
      startLine: lineNumber,
      endLine: lineNumber,
    })
    .refine(
      (value) =>
        value.endLine >= value.startLine && value.endLine - value.startLine + 1 <= gitBlameMaxLines,
      `Blame line range must cover 1 to ${gitBlameMaxLines} lines`,
    )
    .meta({
      "x-ace-constraint": `endLine >= startLine and endLine - startLine + 1 <= ${gitBlameMaxLines}.`,
    }),
] as const;

export const GitHistoryResults = [
  z.object({
    kind: z.literal("gitLog"),
    entries: z.array(GitLogEntry).max(gitLogMaxLimit),
    hasMore: z.boolean(),
    next: GitLogCursor.optional(),
    /** Output stopped at the daemon's byte or entry cap before the requested page finished. */
    capped: z.boolean(),
    head: CommitSha.nullable(),
  }),
  z.object({
    kind: z.literal("gitBlame"),
    head: CommitSha.nullable(),
    commits: z.array(GitBlameCommit).max(gitBlameMaxLines),
    lines: z.array(GitBlameLine).max(gitBlameMaxLines),
    /** Output stopped at the daemon's byte or line cap before the requested range finished. */
    capped: z.boolean(),
  }),
] as const;
