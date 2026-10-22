import type {
  ForgeComment,
  ForgeHiddenReason,
  ForgePrStatus,
  ForgeReviewAnchor,
  ForgeReviewState,
} from "@ace/protocol";
import type { DiffRow } from "@ace/ui-core";

/** Pure rules behind the PR's comments: links, hidden state, thread placement and wording. */

type ReviewThread = ForgePrStatus["reviewThreads"][number];

/** The comment's own address on GitHub, under the pull request's. */
export function commentUrl(prUrl: string, comment: Pick<ForgeComment, "kind" | "id">): string {
  const anchor =
    comment.kind === "issue"
      ? `issuecomment-${comment.id}`
      : comment.kind === "inline"
        ? `discussion_r${comment.id}`
        : `pullrequestreview-${comment.id}`;
  return `${prUrl}#${anchor}`;
}

export const hiddenReasons: readonly { value: ForgeHiddenReason; label: string }[] = [
  { value: "off-topic", label: "Off-topic" },
  { value: "outdated", label: "Outdated" },
  { value: "resolved", label: "Resolved" },
  { value: "duplicate", label: "Duplicate" },
  { value: "spam", label: "Spam" },
];

/** "outdated" → "outdated", "OFF_TOPIC" → "off-topic": GitHub's reason as a sentence word. */
export function hiddenWord(reason: string): string {
  return (
    reason
      .toLowerCase()
      .replaceAll(/[_\s]+/g, "-")
      .replaceAll("-", " ")
      .trim() || "hidden"
  );
}

type Visibility = Pick<ForgeReviewState, "hidden" | "hideable">;

/** Why `comment` is hidden on GitHub, or undefined while it shows (or isn't hideable at all). */
export function hiddenReasonOf(
  state: Visibility | undefined,
  comment: Pick<ForgeComment, "kind" | "id">,
): string | undefined {
  if (comment.kind === "review") return undefined;
  return state?.hidden?.find((h) => h.source === comment.kind && h.commentId === comment.id)
    ?.reason;
}

/** Whether the viewer may hide or unhide `comment`. */
export function canHide(
  state: Visibility | undefined,
  comment: Pick<ForgeComment, "kind" | "id">,
): boolean {
  if (comment.kind === "review") return false;
  return !!state?.hideable?.some((h) => h.source === comment.kind && h.commentId === comment.id);
}

/** "1 comment", "3 comments". */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

/** The diff side a thread's lines count on; reads without a side meant the new file. */
export function threadSide(thread: Pick<ReviewThread, "side">): "old" | "new" {
  return thread.side === "LEFT" ? "old" : "new";
}

/** "line 12", "lines 12–15", with "old" before lines of the base file. */
export function linesLabel(side: "old" | "new", start: number, end = start): string {
  const lines = end > start ? `lines ${start}–${end}` : `line ${start}`;
  return side === "old" ? `old ${lines}` : lines;
}

/** Where a thread sits, "src/a.ts:12" or "src/a.ts:12–15", for rows outside the diff. */
export function threadPlace(thread: Pick<ReviewThread, "file" | "line" | "startLine">): string {
  if (thread.line === null) return thread.file;
  const start = thread.startLine ?? undefined;
  return start && start < thread.line
    ? `${thread.file}:${start}–${thread.line}`
    : `${thread.file}:${thread.line}`;
}

/** Where a pending draft sits, "src/a.ts:12–15". */
export function draftPlace(anchor: ForgeReviewAnchor): string {
  const start = anchor.startLine;
  return start && start < anchor.line
    ? `${anchor.path}:${start}–${anchor.line}`
    : `${anchor.path}:${anchor.line}`;
}

/** The thread whose comments include `commentId`. */
export function threadOfComment(
  threads: readonly ReviewThread[],
  commentId: number,
): ReviewThread | undefined {
  return threads.find((thread) => thread.comments.some((comment) => comment.id === commentId));
}

/**
 * A suggestion block holding the selected lines as they read now, for the reviewer to edit
 * into what they should read. Lines come from the diff's new side; deleted lines never count.
 */
export function suggestionBlock(rows: readonly DiffRow[], start: number, end: number): string {
  const lines: string[] = [];
  const visit = (row: DiffRow) => {
    if (row.kind === "fold") {
      for (const inner of row.lines ?? []) visit(inner);
      return;
    }
    if (row.kind !== "del" && row.new !== undefined && row.new >= start && row.new <= end)
      lines[row.new - start] = row.text;
  };
  for (const row of rows) visit(row);
  const body = Array.from({ length: end - start + 1 }, (_, index) => lines[index] ?? "").join("\n");
  return `\`\`\`suggestion\n${body}\n\`\`\`\n`;
}
