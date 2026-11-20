import { useThreadMeta } from "@ace/client-react";
import { changeHunks, lineMarks, type ChangeHunk, type LineMark } from "@ace/ui-core";
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
} {
  const changed = useThreadMeta(threadId)?.details?.diff?.files;
  const { files } = useWorkingTreeDiff(threadId, {
    also: [version],
    enabled: path !== undefined && version !== undefined && changed !== 0,
    // One read per version of a file being edited: keep only the ones in use.
    gcTime: 30_000,
  });
  const file = useMemo(() => files.find((each) => each.path === path), [files, path]);
  return useMemo(
    () =>
      file?.rows.length
        ? { marks: lineMarks(file.rows), hunks: changeHunks(file.rows) }
        : { marks: undefined, hunks: undefined },
    [file],
  );
}
