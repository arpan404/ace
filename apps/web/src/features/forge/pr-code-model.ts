import type { ForgeFile, ForgePrFiles, ForgePrStatus } from "@ace/protocol";
import type { FileChanges, FileDiff } from "@ace/ui-core";

/** A hosted file's patch as the shared diff worker's input. */
export function hostedFileChanges(files: readonly ForgeFile[]): FileChanges[] {
  return files.map((file) => ({
    path: file.path,
    changes: [
      {
        path: file.previousPath ?? file.path,
        kind:
          file.status === "added"
            ? "add"
            : file.status === "removed"
              ? "delete"
              : file.previousPath
                ? "move"
                : "update",
        ...(file.previousPath ? { movePath: file.path } : {}),
        diff: file.patch ?? "",
      },
    ],
  }));
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

/** Whether the diff draws `line` of `diff` on either side, outside folded runs. */
function draws(diff: FileDiff, line: number): boolean {
  return diff.rows.some((row) => row.kind !== "fold" && (row.new === line || row.old === line));
}

/**
 * Open review threads the diff can't show beside their line: outdated, without a line, on a
 * line the patch doesn't draw, or on a file the range doesn't touch (known only once every page
 * has loaded). A file whose diff is still being prepared keeps its threads until it is ready.
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
    return diff !== undefined && !draws(diff, thread.line);
  });
}

/** What the Code tab can't show in full, as short sentences for its one warning. */
export function codeCaveats(facts: {
  viewed: "available" | "unavailable" | "all-commits-only";
  withheld: boolean;
  truncated: boolean;
  commitsTruncated: boolean;
}): string[] {
  const notes: string[] = [];
  if (facts.viewed === "unavailable")
    notes.push("GitHub's viewed state is unavailable, so no file shows as viewed.");
  if (facts.viewed === "all-commits-only")
    notes.push("Viewed marks apply to All commits, not to a single commit.");
  if (facts.withheld)
    notes.push("GitHub withheld some patches (binary or too large). Open GitHub to see them.");
  if (facts.truncated) notes.push("GitHub lists at most 3,000 files for a pull request.");
  if (facts.commitsTruncated) notes.push("GitHub lists only the first 250 commits.");
  return notes;
}
