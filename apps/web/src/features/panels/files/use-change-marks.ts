import { useThreadMeta } from "@ace/client-react";
import { lineMarks, type LineMark } from "@ace/ui-core";
import { useMemo } from "react";
import { useWorkingTreeDiff } from "@/lib/diffs/use-working-tree.ts";

/**
 * A checkout file's lines changed since the last commit, for its viewer's gutter: read from the
 * same git diff Changes shows, again whenever the file's version changes. Nothing is read while
 * the checkout reports nothing uncommitted. Undefined when the file has no uncommitted change.
 */
export function useChangeMarks(
  threadId: string,
  path: string | undefined,
  version: string | undefined,
): ReadonlyMap<number, LineMark> | undefined {
  const changed = useThreadMeta(threadId)?.details?.diff?.files;
  const { files } = useWorkingTreeDiff(threadId, {
    also: [version],
    enabled: path !== undefined && version !== undefined && changed !== 0,
    // One read per version of a file being edited: keep only the ones in use.
    gcTime: 30_000,
  });
  const file = useMemo(() => files.find((each) => each.path === path), [files, path]);
  return useMemo(() => (file?.rows.length ? lineMarks(file.rows) : undefined), [file]);
}
