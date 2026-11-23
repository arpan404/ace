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
  /** Older bytes were dropped mid-line: the window's first line is the end of a longer one. */
  private partial = false;
  accept(chunk: Buffer): void {
    if (chunk.length > keptBytes) this.dropped(chunk[chunk.length - keptBytes - 1]);
    const kept = chunk.length > keptBytes ? chunk.subarray(chunk.length - keptBytes) : chunk;
    this.chunks.push(Buffer.from(kept));
    this.bytes += kept.length;
    while (this.chunks.length > 1 && this.bytes - (this.chunks[0]?.length ?? 0) >= keptBytes) {
      const first = this.chunks.shift();
      this.bytes -= first?.length ?? 0;
      this.dropped(first?.at(-1));
    }
  }
  /** Records the last byte dropped before the window: whether the window starts mid-line. */
  private dropped(byte: number | undefined): void {
    this.partial = byte !== 0x0a && byte !== 0x0d;
  }
  /**
   * What Git said, minus Trace2 records, with credentials redacted. Empty when it said nothing.
   * The whole window is redacted first, the line its cut split still in view (a label there
   * redacts the value after it), and only then is that line dropped and the text clipped.
   */
  text(): string {
    const redacted = redact(Buffer.concat(this.chunks).toString("utf8").replace(/\r/g, "\n"));
    const lines = redacted.split("\n");
    if (this.partial) lines.shift();
    const said = lines.filter((line) => line.trim() && !line.includes('{"event"'));
    return said.join("\n").slice(-reportedCharacters);
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
  path_outside_repo: "Path is outside the repository",
  no_upstream: "This repository has no remote to fetch from",
  staged_meanwhile: "Something was staged meanwhile. Review and commit again.",
  private_path_staged:
    "ace's own Recently deleted files are staged; unstage them before committing",
};

/** One plain sentence for a failed command's cause. What Git wrote stays in `details.stderr`. */
export function failureMessage(code: GitErrorCode): string {
  return messages[code] ?? "Git command failed";
}
