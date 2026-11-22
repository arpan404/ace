import { useClient, useConnectionState, useThreadMeta } from "@ace/client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { useTurns } from "@/lib/diffs/use-turns.ts";
import { threadCheckoutRoot } from "@/lib/thread-fields.ts";
import { watchFolders } from "../../files/folder-watch.ts";
import {
  branchOptionsFrom,
  buildSections,
  lastTurnEditedPaths,
  type GitStatusReply,
  type SourceControlSections,
} from "./source-control-model.ts";
import {
  readBranches,
  readSourceControlStatus,
  readStashes,
  sourceControlErrorCode,
  sourceControlErrorText,
} from "./source-control-source.ts";

/** Debounce live filesystem watch notifications before re-reading git status. */
const watchRefreshMs = 250;

export const sourceControlStatusKey = (threadId: string) =>
  ["source-control-status", threadId] as const;

export const sourceControlBranchesKey = (threadId: string) =>
  ["source-control-branches", threadId] as const;

export const sourceControlStashesKey = (threadId: string) =>
  ["source-control-stashes", threadId] as const;

export const sourceControlDiffKey = (threadId: string) =>
  ["source-control-diff", threadId] as const;

/**
 * Changed-file count for the Source control badge in the explorer header. Reads `git.status`
 * reactively from TanStack Query's cache when Source control has loaded, falling back to
 * `thread.details.diff.files` before Source control is opened so no extra RPC runs prematurely.
 */
export function useSourceControlCount(threadId: string, active: boolean): number {
  const thread = useThreadMeta(threadId);
  const details = thread?.details;
  const query = useDaemonQuery({
    queryKey: [
      ...sourceControlStatusKey(threadId),
      details?.worktree,
      details?.head,
      details?.branch,
      details?.ahead,
      details?.behind,
      details?.diff?.files,
      details?.diff?.additions,
      details?.diff?.deletions,
      thread?.status.state,
    ],
    enabled: active,
    staleTime: 0,
    retry: false,
    read: (client, signal) => readSourceControlStatus(client, threadId, signal),
  });
  if (query.data) return buildSections(query.data).totalCount;
  return details?.diff?.files ?? 0;
}

export interface SourceControlActionError {
  readonly code: string | undefined;
  readonly message: string;
}

/**
 * Live Source control state for a thread's checkout: `git.status`, branches, stashes, running-turn
 * agent edit detection, live refresh from `files.folders_changed` / `files.changed` and
 * `thread.details`, and cache invalidation after any mutation.
 */
export function useSourceControl(threadId: string) {
  const client = useClient();
  const queryClient = useQueryClient();
  const online = useConnectionState() === "ready";
  const thread = useThreadMeta(threadId);
  const details = thread?.details;
  const turns = useTurns(threadId);

  const statusQuery = useDaemonQuery<GitStatusReply>({
    queryKey: [
      ...sourceControlStatusKey(threadId),
      details?.worktree,
      details?.head,
      details?.branch,
      details?.ahead,
      details?.behind,
      details?.diff?.files,
      details?.diff?.additions,
      details?.diff?.deletions,
      thread?.status.state,
    ],
    staleTime: 0,
    retry: false,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === threadId && previousQuery?.queryKey[2] === details?.worktree
        ? previous
        : undefined,
    read: (daemon, signal) => readSourceControlStatus(daemon, threadId, signal),
  });

  const branchesQuery = useDaemonQuery({
    queryKey: [...sourceControlBranchesKey(threadId), details?.worktree, details?.branch],
    staleTime: 30_000,
    retry: false,
    enabled: online,
    read: (daemon, signal) => readBranches(daemon, threadId, signal),
  });

  const stashesQuery = useDaemonQuery({
    queryKey: [...sourceControlStashesKey(threadId), details?.worktree],
    staleTime: 30_000,
    retry: false,
    enabled: online,
    read: (daemon, signal) => readStashes(daemon, threadId, signal),
  });

  const refresh = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: sourceControlStatusKey(threadId) }),
      queryClient.invalidateQueries({ queryKey: sourceControlBranchesKey(threadId) }),
      queryClient.invalidateQueries({ queryKey: sourceControlStashesKey(threadId) }),
      queryClient.invalidateQueries({ queryKey: sourceControlDiffKey(threadId) }),
      queryClient.invalidateQueries({ queryKey: ["working-tree-diff", threadId] }),
    ]);
  }, [queryClient, threadId]);

  // Hold a root folder watch while Source control is mounted, and debounce live refresh from
  // filesystem notifications rather than polling.
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scheduleRefresh = useCallback(() => {
    clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      void queryClient.invalidateQueries({ queryKey: sourceControlStatusKey(threadId) });
      void queryClient.invalidateQueries({ queryKey: sourceControlDiffKey(threadId) });
    }, watchRefreshMs);
  }, [queryClient, threadId]);

  useEffect(() => {
    const watch = watchFolders(client, threadId);
    watch.set([""]);
    const stop = client.onMessage((message) => {
      if (message.type === "files.folders_changed" && message.threadId === threadId) {
        scheduleRefresh();
      } else if (message.type === "files.changed") {
        scheduleRefresh();
      }
    });
    return () => {
      clearTimeout(refreshTimer.current);
      stop();
      watch.leave();
    };
  }, [client, threadId, scheduleRefresh]);

  const sections: SourceControlSections = useMemo(
    () => buildSections(statusQuery.data),
    [statusQuery.data],
  );

  const checkoutRoot = thread ? threadCheckoutRoot(thread) : undefined;
  const agentTurnPaths = useMemo(
    () => lastTurnEditedPaths(turns, checkoutRoot),
    [turns, checkoutRoot],
  );

  const [pendingAction, setPendingAction] = useState<string | undefined>(undefined);
  const pending = useRef<string | undefined>(undefined);
  const [actionError, setActionError] = useState<SourceControlActionError | undefined>(undefined);

  const runAction = useCallback(
    async <T>(name: string, task: () => Promise<T>): Promise<T | undefined> => {
      // One Git action at a time: a second would race the first on the checkout's lock, and
      // its finish would clear the first's pending state while that still runs.
      if (pending.current !== undefined) return undefined;
      pending.current = name;
      setPendingAction(name);
      setActionError(undefined);
      try {
        const result = await task();
        await refresh();
        return result;
      } catch (error) {
        setActionError({
          code: sourceControlErrorCode(error),
          message: sourceControlErrorText(error),
        });
        // A failed pull may have fetched, a conflicted pop left unmerged files: show what's there.
        await refresh();
        return undefined;
      } finally {
        pending.current = undefined;
        setPendingAction(undefined);
      }
    },
    [refresh],
  );

  const statusErrorCode = statusQuery.isError
    ? sourceControlErrorCode(statusQuery.error)
    : undefined;
  const branch = statusQuery.data?.branch ?? details?.branch ?? null;
  const branches = useMemo(
    () => branchOptionsFrom(branchesQuery.data, branch),
    [branchesQuery.data, branch],
  );

  const state = thread?.status.state;
  const agentWorking = state === "working" || state === "needs_you" || state === "waiting";

  return {
    online,
    thread,
    agentWorking,
    status: statusQuery.data,
    statusLoading: statusQuery.isPending && !statusQuery.data,
    statusRefreshing: statusQuery.isFetching && !statusQuery.isPlaceholderData,
    statusError: statusQuery.isError ? sourceControlErrorText(statusQuery.error) : undefined,
    statusErrorCode,
    sections,
    branch,
    ahead: statusQuery.data?.ahead ?? details?.ahead ?? 0,
    behind: statusQuery.data?.behind ?? details?.behind ?? 0,
    head: statusQuery.data?.head ?? details?.head ?? null,
    branches,
    branchesLoading: branchesQuery.isFetching && !branchesQuery.data,
    stashes: stashesQuery.data?.stashes ?? [],
    stashesLoading: stashesQuery.isFetching && !stashesQuery.data,
    agentTurnPaths,
    pendingAction,
    actionError,
    clearActionError: () => setActionError(undefined),
    runAction,
    refresh,
    refetchBranches: () => void branchesQuery.refetch(),
    refetchStashes: () => void stashesQuery.refetch(),
  };
}
