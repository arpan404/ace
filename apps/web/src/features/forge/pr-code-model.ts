import type { ForgeFile, ForgePrFiles, ForgePrStatus } from "@ace/protocol";
import type { FileChanges, FileDiff } from "@ace/ui-core";
import { diffSide, lineKeyOf } from "./pr-code-comments.ts";

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
    return diff !== undefined && !lineKeyOf(diff, diffSide(thread.side), thread.line);
  });
}
