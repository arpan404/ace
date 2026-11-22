import { createTextRedactor } from "@ace/redaction";
import type { GitErrorCode } from "./types.ts";

/** Bytes of stderr retained per call, and characters of it reported. */
const keptBytes = 16_384;
const reportedCharacters = 4_000;
const redact = createTextRedactor({});

/** The last bytes a failing Git process wrote to stderr, bounded however much it writes. */
export class StderrTail {
  private chunks: Buffer[] = [];
  private bytes = 0;
  accept(chunk: Buffer): void {
    const kept = chunk.length > keptBytes ? chunk.subarray(chunk.length - keptBytes) : chunk;
    this.chunks.push(Buffer.from(kept));
    this.bytes += kept.length;
    while (this.chunks.length > 1 && this.bytes - (this.chunks[0]?.length ?? 0) >= keptBytes) {
      this.bytes -= this.chunks.shift()?.length ?? 0;
    }
  }
  /** What Git said, minus Trace2 records, with credentials redacted. Empty when it said nothing. */
  text(): string {
    const lines = Buffer.concat(this.chunks)
      .toString("utf8")
      .replace(/\r/g, "\n")
      .split("\n")
      .filter((line) => line.trim() && !line.includes('{"event"'));
    return redact(lines.join("\n").slice(-reportedCharacters));
  }
}

const messages: Partial<Record<GitErrorCode, string>> = {
  objects_not_available: "Objects not available locally",
  branch_checked_out: "The branch is already checked out in another worktree",
  path_exists: "The worktree path already exists",
  ref_conflict: "The branch name conflicts with an existing branch",
  unborn_head: "The repository has no commits yet",
  identity_missing: "Git has no author name or email configured",
  nothing_to_commit: "There is nothing to commit",
  push_rejected: "The remote has commits this branch does not; pull or rebase first",
  protected_branch: "The remote refused the push: the branch is protected",
  push_lease_stale: "The remote branch moved past the leased revision; fetch and review first",
  pull_diverged: "Branch diverged from its upstream and cannot fast-forward",
  no_upstream: "Current branch has no upstream configured",
  trash_unavailable: "Recently deleted is unavailable; cannot discard untracked files",
  stash_empty: "There are no stashes to pop",
  nothing_to_stash: "There are no local changes to stash",
  path_outside_repo: "Path is outside the repository",
  changed_since_review: "A file changed after you reviewed it; look again before discarding",
  path_occupied: "Another file already uses that name",
  amend_published: "A remote already has this commit; amending rewrites it",
  private_path_staged:
    "ace's own Recently deleted files are staged; unstage them before committing",
  index_moved: "The staged changes moved after you reviewed them; look again before committing",
  untracked_overwritten:
    "Files Git doesn't track, or ignores, would be overwritten; move them first",
};

/** One plain sentence for a failed command's cause. What Git wrote stays in `details.stderr`. */
export function failureMessage(code: GitErrorCode): string {
  return messages[code] ?? "Git command failed";
}
