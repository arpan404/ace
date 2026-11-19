import type { ForgeFile, ForgePrFiles, ForgePrStatus } from "@ace/protocol";
import { fillFolds, hideWhitespace, hostedFileShow, type FileDiff } from "@ace/ui-core";
import { diffSide, lineKeyOf } from "./pr-code-comments.ts";
import type { SideTexts } from "./pr-code-model.ts";
import type { CodeThreadStop } from "./pr-code-nav.ts";

type ReviewThread = ForgePrStatus["reviewThreads"][number];

/**
 * Each file's diff as the Code tab draws it: a patch's folds filled from the new side once it
 * has been read, and whitespace-only changes shown as unchanged when asked. A diff nothing
 * changes stays the same object.
 */
export function shownDiffs(
  diffs: readonly FileDiff[],
  files: readonly ForgeFile[],
  texts: SideTexts,
  whitespace: boolean,
): FileDiff[] {
  const byPath = new Map(files.map((file) => [file.path, file]));
  return diffs.map((diff) => {
    const file = byPath.get(diff.path);
    const newText = texts.get(diff.path)?.newText;
    let rows = diff.rows;
    if (file && hostedFileShow(file) === "patch" && typeof newText === "string")
      rows = fillFolds(rows, newText);
    if (whitespace) rows = hideWhitespace(rows);
    return rows === diff.rows ? diff : { ...diff, rows };
  });
}

/**
 * The conversations the range can draw beside its lines, by file. All commits draws every
 * one. A commit view whose new side is the head's draws those on the new side (the old side
 * is the commit before, not the base they were written on); a view of older code draws none.
 */
export function threadsAtHead(
  threads: readonly ReviewThread[],
  range: Pick<ForgePrFiles, "headSha" | "commit"> | undefined,
  head: string,
): ReadonlyMap<string, ReviewThread[]> {
  const byFile = new Map<string, ReviewThread[]>();
  if (!range || (range.commit && range.headSha !== head)) return byFile;
  for (const thread of threads) {
    if (range.commit && (thread.outdated || thread.side === "LEFT")) continue;
    const list = byFile.get(thread.file) ?? [];
    list.push(thread);
    byFile.set(thread.file, list);
  }
  return byFile;
}

/**
 * Where Next comment goes, in reading order: the strip above the files first, then each
 * file's conversations from its first line to its last, as far as the files are read.
 */
export function codeThreadStops(
  offDiff: readonly ReviewThread[],
  files: readonly ForgeFile[],
  diffs: ReadonlyMap<string, FileDiff>,
  threads: ReadonlyMap<string, readonly ReviewThread[]>,
): CodeThreadStop[] {
  const off = new Set(offDiff.map((thread) => thread.id));
  const stops: CodeThreadStop[] = offDiff.map((thread) => ({
    id: thread.id,
    path: undefined,
    resolved: thread.resolved,
  }));
  for (const file of files) {
    const diff = diffs.get(file.path);
    if (!diff) continue;
    const placed = (threads.get(file.path) ?? []).filter(
      (thread) =>
        !off.has(thread.id) &&
        thread.line !== null &&
        !!lineKeyOf(diff, diffSide(thread.side), thread.line),
    );
    placed.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
    for (const thread of placed)
      stops.push({ id: thread.id, path: file.path, resolved: thread.resolved });
  }
  return stops;
}
