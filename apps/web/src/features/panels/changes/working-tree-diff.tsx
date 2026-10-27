import { contentHash } from "@ace/ui-core";
import { GitDiffIcon } from "@phosphor-icons/react";
import { useMemo } from "react";
import { EmptyState } from "@/components/ui/empty.tsx";
import { useWorkingTreeDiff } from "@/lib/diffs/use-working-tree.ts";

/**
 * Uncommitted changes as git reports them, file by file in the same diff view as the agents'
 * edits. Their lines are the checkout's, so this is where review comments go: each is recorded
 * against the working tree's review with the lines it was made on. Read only while `shown`.
 */
export function useUncommitted(threadId: string, shown: boolean) {
  const { query: diff, files } = useWorkingTreeDiff(threadId, { enabled: shown });
  const stat = useMemo(
    () =>
      files.reduce(
        (sum, file) => ({
          additions: sum.additions + file.additions,
          deletions: sum.deletions + file.deletions,
        }),
        { additions: 0, deletions: 0 },
      ),
    [files],
  );
  // A file's version is its diff as read: a new read with other lines detaches open comments.
  const versions = useMemo(
    () => new Map(files.map((file) => [file.path, contentHash(JSON.stringify(file.rows))])),
    [files],
  );
  const body = diff.isError ? (
    <EmptyState
      icon={GitDiffIcon}
      title="Couldn't read changes"
      description="Check that this thread has a git checkout, then refresh."
    />
  ) : !diff.data ? (
    <p role="status" className="p-3.5 text-sm text-muted-foreground">
      Reading changes…
    </p>
  ) : files.length ? undefined : (
    <EmptyState
      icon={GitDiffIcon}
      title="No uncommitted changes"
      description="The working tree matches HEAD."
      className="justify-start pt-6"
    />
  );
  const notice = diff.data?.truncated && (
    <p role="status" className="px-3.5 py-2 text-xs text-subtle-foreground">
      This diff is truncated at 256 KiB. The last file may be cut short.
    </p>
  );
  return {
    files,
    versions,
    stat,
    body,
    notice,
    refresh: () => void diff.refetch(),
    refreshing: diff.isFetching,
  };
}
