import { useThreadMeta } from "@ace/client-react";
import { gitPatchFiles } from "@ace/ui-core";
import { useMemo } from "react";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { readGitDiff } from "@/lib/git-diff.ts";

/** Run states in which agents may still be changing the checkout. */
const activeStates = new Set(["working", "waiting", "needs_you"]);

/**
 * The thread checkout's uncommitted changes as git reports them (HEAD to the working tree), each
 * file parsed once per read. Read from git rather than provider edit events, so shell commands
 * and manual edits count too. Read again when the checkout's facts move (a commit, a terminal's
 * too, a move to another checkout, its change counts), when the thread's agents stop working,
 * and when anything in `also` changes (the agents' edits, a file's version). While a new read
 * runs the last one stays shown: the daemon answers an unchanged checkout from its cache.
 */
export function useWorkingTreeDiff(
  threadId: string,
  options: { also?: readonly unknown[]; enabled?: boolean; gcTime?: number } = {},
) {
  const thread = useThreadMeta(threadId);
  const details = thread?.details;
  const query = useDaemonQuery<Awaited<ReturnType<typeof readGitDiff>>>({
    queryKey: [
      "working-tree-diff",
      threadId,
      thread ? activeStates.has(thread.status.state) : undefined,
      details?.worktree,
      details?.head,
      details?.diff?.files,
      details?.diff?.additions,
      details?.diff?.deletions,
      ...(options.also ?? []),
    ],
    staleTime: 0,
    retry: false,
    enabled: options.enabled ?? true,
    // Only the last read of this thread's same checkout: another's is never shown as this one.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === threadId && previousQuery.queryKey[3] === details?.worktree
        ? previous
        : undefined,
    ...(options.gcTime === undefined ? {} : { gcTime: options.gcTime }),
    read: (client, signal) => readGitDiff(client, threadId, signal),
  });
  const patch = query.data?.patch;
  // Linear in the patch (the daemon caps it at 256 KiB: under a millisecond), once per read.
  const files = useMemo(() => gitPatchFiles(patch ?? ""), [patch]);
  return { query, files };
}
