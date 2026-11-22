import type { ClientApi } from "@ace/client";
import { CommitSha, ReviewPath, ThreadId, type GitLogCursor } from "@ace/protocol";
import { CommandRefused } from "./daemon-command.ts";

/** One commit opened in the read-only commit diff viewer (from Timeline or Inline Blame). */
export interface CommitDiffTarget {
  /** File path at this commit (or current checkout path). */
  path: string;
  /** Previous path if the commit renamed the file. */
  previousPath?: string | undefined;
  sha: string;
  shortSha: string;
  subject: string;
  authorName: string;
  authoredAt: number;
}

/** Reads a file's commit history via `git.log` (renames followed, paged). */
export async function readGitLog(
  client: ClientApi,
  threadId: string,
  path: string,
  options?: { cursor?: GitLogCursor | undefined; limit?: number; signal?: AbortSignal },
) {
  const reply = await client.request(
    {
      type: "workspace.request",
      operation: {
        op: "git.log",
        threadId: ThreadId.parse(threadId),
        path: ReviewPath.parse(path),
        ...(options?.cursor ? { cursor: options.cursor } : {}),
        limit: options?.limit ?? 25,
      },
    },
    options?.signal ? { signal: options.signal } : {},
  );
  if (reply.result.kind !== "gitLog") throw new CommandRefused("git_log_unavailable");
  return reply.result;
}

/**
 * Reads blame for a bounded 1-based line range of a file at `commit` via `git.blame`. Lines are
 * the file's lines at that commit.
 */
export async function readGitBlame(
  client: ClientApi,
  threadId: string,
  path: string,
  range: { commit: string; startLine: number; endLine: number },
  signal?: AbortSignal,
) {
  const { commit, startLine, endLine } = range;
  const reply = await client.request(
    {
      type: "workspace.request",
      operation: {
        op: "git.blame",
        threadId: ThreadId.parse(threadId),
        path: ReviewPath.parse(path),
        commit: CommitSha.parse(commit),
        startLine,
        endLine,
      },
    },
    signal ? { signal } : {},
  );
  if (reply.result.kind !== "gitBlame") throw new CommandRefused("git_blame_unavailable");
  return reply.result;
}

/** Reads a commit-scoped unified diff for one file via `git.diff`. */
export async function readGitCommitDiff(
  client: ClientApi,
  threadId: string,
  options: {
    path: string;
    commit: string;
    from?: string | undefined;
    offset?: number | undefined;
    expected?: string | undefined;
    signal?: AbortSignal | undefined;
  },
) {
  const reply = await client.request(
    {
      type: "workspace.request",
      operation: {
        op: "git.diff",
        threadId: ThreadId.parse(threadId),
        path: ReviewPath.parse(options.path),
        ...(options.from ? { from: ReviewPath.parse(options.from) } : {}),
        commit: CommitSha.parse(options.commit),
        ...(options.offset !== undefined ? { offset: options.offset } : {}),
        ...(options.expected !== undefined ? { expected: options.expected } : {}),
      },
    },
    options.signal ? { signal: options.signal } : {},
  );
  if (reply.result.kind !== "gitDiff") throw new CommandRefused("git_diff_unavailable");
  return reply.result;
}

/**
 * Pure human-readable relative time in words ("just now", "3 minutes ago", "3 days ago")
 * for Timeline rows and inline git blame annotations.
 */
export function formatRelativeWords(atMs: number, nowMs: number): string {
  const diffSec = Math.max(0, Math.floor((nowMs - atMs) / 1000));
  if (diffSec < 45) return "just now";
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return mins === 1 ? "1 minute ago" : `${mins} minutes ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return days === 1 ? "1 day ago" : `${days} days ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 8) return weeks === 1 ? "1 week ago" : `${weeks} weeks ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return months === 1 ? "1 month ago" : `${months} months ago`;
  const years = Math.floor(days / 365);
  return years === 1 ? "1 year ago" : `${years} years ago`;
}
