import type {
  ForgeComment,
  ForgeHiddenReason,
  ForgePrStatus,
  ForgeReviewAnchor,
  ForgeReviewState,
} from "@ace/protocol";
import type { DiffRow } from "./diff.ts";

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
const commentKey = (kind: "issue" | "inline", id: number) => `${kind}:${id}`;

// Each review state's lists are indexed once, so every comment looks itself up in O(1).
const hiddenIndexes = new WeakMap<object, ReadonlyMap<string, string>>();
const hideableIndexes = new WeakMap<object, ReadonlySet<string>>();
function hiddenIndex(list: NonNullable<Visibility["hidden"]>): ReadonlyMap<string, string> {
  let index = hiddenIndexes.get(list);
  if (!index) {
    index = new Map(list.map((h) => [commentKey(h.source, h.commentId), h.reason]));
    hiddenIndexes.set(list, index);
  }
  return index;
}
function hideableIndex(list: NonNullable<Visibility["hideable"]>): ReadonlySet<string> {
  let index = hideableIndexes.get(list);
  if (!index) {
    index = new Set(list.map((h) => commentKey(h.source, h.commentId)));
    hideableIndexes.set(list, index);
  }
  return index;
}

/** Why `comment` is hidden on GitHub, or undefined while it shows (or isn't hideable at all). */
export function hiddenReasonOf(
  state: Visibility | undefined,
  comment: Pick<ForgeComment, "kind" | "id">,
): string | undefined {
  if (comment.kind === "review" || !state?.hidden) return undefined;
  return hiddenIndex(state.hidden).get(commentKey(comment.kind, comment.id));
}

/** Whether the viewer may hide or unhide `comment`. */
export function canHide(
  state: Visibility | undefined,
  comment: Pick<ForgeComment, "kind" | "id">,
): boolean {
  if (comment.kind === "review" || !state?.hideable) return false;
  return hideableIndex(state.hideable).has(commentKey(comment.kind, comment.id));
}

/** A comment's first line for a one-line preview; a hidden comment's text is never shown. */
export function previewOf(
  state: Visibility | undefined,
  comment: Pick<ForgeComment, "kind" | "id" | "body">,
): { text: string; hidden: boolean } {
  return hiddenReasonOf(state, comment) === undefined
    ? { text: comment.body.split("\n")[0] ?? "", hidden: false }
    : { text: "Hidden comment", hidden: true };
}

/** "1 comment", "3 comments". */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
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
