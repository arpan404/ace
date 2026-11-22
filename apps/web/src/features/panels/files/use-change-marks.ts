import { useThreadMeta } from "@ace/client-react";
import {
  changeHunks,
  lineMarks,
  patchSections,
  type ChangeHunk,
  type LineMark,
} from "@ace/ui-core";
import { useMemo } from "react";
import { useWorkingTreeDiff } from "@/lib/diffs/use-working-tree.ts";

/**
 * A checkout file's lines changed since the last commit, for its viewer's gutter, and the hunks
 * behind them (what each run of lines replaced): read from the same git diff Changes shows,
 * again whenever the file's version changes. Nothing is read while the checkout reports nothing
 * uncommitted. Both undefined when the file has no uncommitted change.
 */
export function useChangeMarks(
  threadId: string,
  path: string | undefined,
  version: string | undefined,
): {
  marks: ReadonlyMap<number, LineMark> | undefined;
  hunks: readonly ChangeHunk[] | undefined;
  /**
   * The diff was read for this version (or there is nothing uncommitted to read): no hunks then
   * means the file is as committed. False while a read runs, fails or shows an older one.
   */
  settled: boolean;
  /** The commit the diff is read against. */
  head: string | undefined;
  /** The file's part of `git diff`, exactly as read (its line endings and final newlines). */
  patch: string | undefined;
} {
  const details = useThreadMeta(threadId)?.details;
  const changed = details?.diff?.files;
  const head = details?.head ?? undefined;
  const { files, query } = useWorkingTreeDiff(threadId, {
    also: [version],
    enabled: path !== undefined && version !== undefined && changed !== 0,
    // One read per version of a file being edited: keep only the ones in use.
    gcTime: 30_000,
  });
  const file = useMemo(() => files.find((each) => each.path === path), [files, path]);
  const raw = query.data?.patch;
  const patch = useMemo(
    () => (raw ? patchSections(raw).find((section) => section.path === path)?.text : undefined),
    [raw, path],
  );
  const settled = changed === 0 || (query.isSuccess && !query.isPlaceholderData);
  return useMemo(
    () =>
      file?.rows.length
        ? { marks: lineMarks(file.rows), hunks: changeHunks(file.rows), settled, head, patch }
        : { marks: undefined, hunks: undefined, settled, head, patch },
    [file, settled, head, patch],
  );
}
