import type { ForgeFile, ForgePrFiles, ForgePrStatus } from "@ace/protocol";
import type { FileChanges, FileDiff } from "@ace/ui-core";

/** Both sides of a file, read whole where GitHub withheld its patch; null where there is none. */
export type SideTexts = ReadonlyMap<string, { oldText: string | null; newText: string | null }>;
const noTexts: SideTexts = new Map();

/**
 * Hosted files as the shared diff worker's input: GitHub's patch, or both sides' text where it
 * withheld the patch and they have been read (which also lets every unchanged run expand).
 */
export function hostedFileChanges(
  files: readonly ForgeFile[],
  texts: SideTexts = noTexts,
): FileChanges[] {
  return files.map((file) => {
    const kind =
      file.status === "added"
        ? "add"
        : file.status === "removed"
          ? "delete"
          : file.previousPath
            ? "move"
            : "update";
    const whole = texts.get(file.path);
    return {
      path: file.path,
      changes: [
        {
          path: file.previousPath ?? file.path,
          kind,
          ...(file.previousPath ? { movePath: file.path } : {}),
          ...(whole
            ? {
                oldText: whole.oldText,
                ...(whole.newText === null ? {} : { newText: whole.newText }),
              }
            : { diff: file.patch ?? "" }),
        },
      ],
    };
  });
}

export const hostedFileStatus = (file: ForgeFile): FileDiff["status"] =>
  file.status === "added"
    ? "added"
    : file.status === "removed"
      ? "deleted"
      : file.status === "renamed"
        ? "moved"
        : "modified";

/**
 * The pages read so far as one range: every file once (a page that repeats a path keeps the
 * first), in host order. Undefined until the first page arrives.
 */
export function joinFilePages(pages: readonly ForgePrFiles[]): ForgePrFiles | undefined {
  const first = pages[0];
  if (!first) return undefined;
  const seen = new Set<string>();
  const files: ForgeFile[] = [];
  for (const page of pages)
    for (const file of page.files)
      if (!seen.has(file.path)) {
        seen.add(file.path);
        files.push(file);
      }
  const last = pages.at(-1) ?? first;
  return {
    ref: first.ref,
    baseSha: first.baseSha,
    headSha: first.headSha,
    ...(first.commit ? { commit: first.commit } : {}),
    files,
    truncated: pages.some((page) => page.truncated),
    ...(last.nextPage ? { nextPage: last.nextPage } : {}),
  };
}

type ReviewThread = ForgePrStatus["reviewThreads"][number];

/** A diff line a comment can sit under: the side and number its row is addressed by. */
export type LineKey = `${"old" | "new"}:${number}`;

/**
 * The row a comment on `line` of `side` hangs under, as the diff addresses its rows: a deleted
 * line by its old number, every other line by its new one (so a comment on the old side of an
 * unchanged line still finds it). Undefined when the diff doesn't draw that line.
 */
export function lineKeyOf(diff: FileDiff, side: "old" | "new", line: number): LineKey | undefined {
  for (const row of diff.rows) {
    if (row.kind === "fold") continue;
    if (
      side === "new"
        ? row.kind !== "del" && row.new === line
        : row.kind !== "add" && row.old === line
    )
      return row.kind === "del" ? `old:${line}` : `new:${row.new ?? line}`;
  }
  return undefined;
}

const sideOf = (side: "LEFT" | "RIGHT" | undefined) => (side === "LEFT" ? "old" : "new");

/**
 * Where each current review thread of `diff`'s file sits: under the row of its last line.
 * Outdated threads and those on lines the diff doesn't draw aren't placed (`offDiffThreads`
 * lists them above the files).
 */
export function placeThreads(
  threads: readonly ReviewThread[],
  diff: FileDiff,
): ReadonlyMap<LineKey, ReviewThread[]> {
  const placed = new Map<LineKey, ReviewThread[]>();
  for (const thread of threads) {
    if (thread.file !== diff.path || thread.outdated || thread.line === null) continue;
    const key = lineKeyOf(diff, sideOf(thread.side), thread.line);
    if (key) placed.set(key, [...(placed.get(key) ?? []), thread]);
  }
  return placed;
}

/**
 * Review threads the diff can't show beside their line: outdated, without a line, on a line
 * the patch doesn't draw, or on a file the range doesn't touch (known only once every page has
 * loaded). A file whose diff is still being prepared keeps its threads until it is ready.
 * Resolved threads are left out.
 */
export function offDiffThreads(
  threads: readonly ReviewThread[],
  range: { files: readonly ForgeFile[]; diffs: readonly FileDiff[]; complete: boolean },
): ReviewThread[] {
  const listed = new Set(range.files.map((file) => file.path));
  const diffs = new Map(range.diffs.map((diff) => [diff.path, diff]));
  return threads.filter((thread) => {
    if (thread.resolved) return false;
    if (thread.outdated || thread.line === null) return true;
    if (!listed.has(thread.file)) return range.complete;
    const diff = diffs.get(thread.file);
    return diff !== undefined && !lineKeyOf(diff, sideOf(thread.side), thread.line);
  });
}

/** What the Code tab can't show in full, as short sentences for its one warning. */
export function codeCaveats(facts: {
  viewed: "available" | "unavailable" | "all-commits-only";
  truncated: boolean;
  commitsTruncated: boolean;
}): string[] {
  const notes: string[] = [];
  if (facts.viewed === "unavailable")
    notes.push("GitHub's viewed state is unavailable, so no file shows as viewed.");
  if (facts.viewed === "all-commits-only")
    notes.push("Viewed marks apply to All commits, not to a single commit.");
  if (facts.truncated) notes.push("Some changed files couldn't be listed.");
  if (facts.commitsTruncated) notes.push("Only the newest 10,000 commits are listed.");
  return notes;
}
