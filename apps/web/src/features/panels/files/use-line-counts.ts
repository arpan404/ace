import { useThreadMeta } from "@ace/client-react";
import { useMemo } from "react";
import { useWorkingTreeDiff } from "@/lib/diffs/use-working-tree.ts";

/** A file's lines added and removed since the checkout's HEAD. */
export interface LineCounts {
  additions: number;
  deletions: number;
}

/**
 * Every uncommitted file's line counts, by path (a move counts under its new path), read from
 * the same git diff Changes shows and refreshed with it. Nothing is read while the checkout
 * reports nothing uncommitted. A binary or mode-only change counts nothing and isn't listed.
 */
export function useLineCounts(threadId: string): ReadonlyMap<string, LineCounts> {
  const changed = useThreadMeta(threadId)?.details?.diff?.files;
  const { files } = useWorkingTreeDiff(threadId, { enabled: changed !== 0 });
  return useMemo(() => {
    const counts = new Map<string, LineCounts>();
    for (const file of files)
      if (file.additions || file.deletions)
        counts.set(file.path, { additions: file.additions, deletions: file.deletions });
    return counts;
  }, [files]);
}
