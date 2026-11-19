import type { GitConflictHunk, GitConflictSegment } from "@ace/protocol";
import { actionErrorText } from "./action-errors.ts";

/** How one hunk is resolved: one side's lines, both (ours first), or text the person wrote. */
export type HunkChoice =
  | { kind: "ours" }
  | { kind: "theirs" }
  | { kind: "both" }
  | { kind: "edit"; text: string };

/** A hunk written back as Git left it, markers included, so it stays to resolve. */
function unresolved(hunk: GitConflictHunk): string {
  return (
    hunk.markers.ours +
    hunk.ours +
    (hunk.markers.base ?? "") +
    (hunk.base ?? "") +
    hunk.markers.separator +
    hunk.theirs +
    hunk.markers.theirs
  );
}

function chosen(hunk: GitConflictHunk, choice: HunkChoice): string {
  if (choice.kind === "ours") return hunk.ours;
  if (choice.kind === "theirs") return hunk.theirs;
  return choice.kind === "both" ? editDraft(hunk) : choice.text;
}

/**
 * The file's text with hunk number `index` (counting hunks only) resolved by `choice`. Every
 * other hunk keeps its markers, and the text around them is unchanged.
 */
export function resolveHunk(
  segments: readonly GitConflictSegment[],
  index: number,
  choice: HunkChoice,
): string {
  let hunk = -1;
  return segments
    .map((segment) => {
      if (segment.kind === "text") return segment.text;
      hunk++;
      return hunk === index ? chosen(segment, choice) : unresolved(segment);
    })
    .join("");
}

/** Each hunk with where it starts in the file's text, which tells hunks apart. */
export function conflictHunks(
  segments: readonly GitConflictSegment[],
): { hunk: GitConflictHunk; start: number }[] {
  let offset = 0;
  const hunks: { hunk: GitConflictHunk; start: number }[] = [];
  for (const segment of segments) {
    if (segment.kind === "conflict") hunks.push({ hunk: segment, start: offset });
    offset += segment.kind === "text" ? segment.text.length : unresolved(segment).length;
  }
  return hunks;
}

/** What Edit starts from: both sides, ours first, so nothing is lost by default. */
export function editDraft(hunk: GitConflictHunk): string {
  return hunk.ours + hunk.theirs;
}

/** The request "Ask agent" puts in the task's composer for one conflicted file. */
export function conflictRequest(input: {
  path: string;
  number: number;
  baseBranch: string;
  headBranch: string;
}): string {
  return `Resolve the merge conflicts in \`${input.path}\` in this checkout of PR #${input.number} (merging ${input.baseBranch} into ${input.headBranch}). Keep what both sides meant, remove every conflict marker, then \`git add\` the file. Don't commit or push: I'll finish the merge from the PR panel.`;
}

/** What a refused conflict step means here, where the checkout is a pull request's own. */
export function conflictRefusalText(code: string | undefined, headBranch: string): string {
  if (code === "git_push_rejected")
    return `${headBranch} moved on GitHub since this checkout was made. Nothing was overwritten: bring its new commits into the checkout, then push again.`;
  if (code === "git_dirty_worktree")
    return "The checkout has uncommitted changes, or untracked files the merge would overwrite. Commit or move them first.";
  if (code === "git_head_moved")
    return "The checkout changed since it was read. Look again, then retry.";
  if (code === "git_pr_head_unavailable")
    return "This checkout doesn't hold this pull request. Check the pull request out here first.";
  return actionErrorText(code ?? "action_outcome_uncertain");
}
