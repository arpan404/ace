import { useThreadMeta } from "@ace/client-react";
import { gitPatchFiles } from "@ace/ui-core";
import { useMemo } from "react";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { readGitDiff } from "@/lib/git-diff.ts";

/**
 * The thread checkout's uncommitted changes as git reports them (HEAD to the working tree), each
 * file parsed once per read. Read from git rather than provider edit events, so shell commands
 * and manual edits count too. A commit (a terminal's too), a move to another checkout and the
 * thread's state moving on read it again, and so does anything in `also` changing (a file's
 * version, for its viewer).
 */
export function useWorkingTreeDiff(
  threadId: string,
  options: { also?: readonly unknown[]; enabled?: boolean; gcTime?: number } = {},
) {
  const thread = useThreadMeta(threadId);
  const query = useDaemonQuery({
    queryKey: [
      "working-tree-diff",
      threadId,
      thread?.status.state,
      thread?.details?.worktree,
      thread?.details?.head,
      ...(options.also ?? []),
    ],
    staleTime: 0,
    retry: false,
    enabled: options.enabled ?? true,
    ...(options.gcTime === undefined ? {} : { gcTime: options.gcTime }),
    read: (client, signal) => readGitDiff(client, threadId, signal),
  });
  const patch = query.data?.patch;
  // Linear in the patch (the daemon caps it at 256 KiB: under a millisecond), once per read.
  const files = useMemo(() => gitPatchFiles(patch ?? ""), [patch]);
  return { query, files };
}
