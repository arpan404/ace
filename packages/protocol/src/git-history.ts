import { z } from "zod";
import { ThreadId } from "./ids.ts";
import { ReviewPath } from "./review.ts";

/** A full Git commit object id (SHA-1 or SHA-256). */
export const CommitSha = z.string().regex(/^[0-9a-f]{40,64}$/);
export type CommitSha = z.infer<typeof CommitSha>;

/** The most commits `git.log` lists: a file's newest ones; older history is for `git log`. */
export const gitLogMaxLimit = 200;
/** Byte cap for one `git.log` read from Git. */
export const gitLogMaxBytes = 1024 * 1024;
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

export const GitHistoryOperations = [
  /**
   * A file's newest commits in the thread's checkout, following renames (`git log --follow`):
   * at most `gitLogMaxLimit`, in one walk bounded by `gitLogMaxBytes` and a work budget.
   */
  z.object({
    op: z.literal("git.log"),
    threadId: ThreadId,
    path: ReviewPath,
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
    /**
     * Why the list ends before the file's first commit: `limit` (the newest commits, or the
     * byte cap), `budget` (the walk ran out of time). Absent when it is the whole history.
     */
    stopped: z.enum(["limit", "budget"]).optional(),
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
