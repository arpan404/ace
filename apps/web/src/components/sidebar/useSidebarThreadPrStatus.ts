import { type GitStatusResult, type ThreadId } from "@ace/contracts";
import { useQueries } from "@tanstack/react-query";

import { gitStatusQueryOptions } from "../../lib/gitReactQuery";
import { getVisibleSidebarThreadIds } from "../../lib/sidebar";
import type { SidebarThreadSummary } from "../../types";

interface UseSidebarThreadPrStatusInput {
  readonly renderedProjects: ReadonlyArray<{
    readonly shouldShowThreadPanel?: boolean;
    readonly renderedThreadIds: readonly ThreadId[];
  }>;
  readonly sidebarThreadsById: Readonly<Record<string, SidebarThreadSummary | undefined>>;
  readonly projectCwdById: ReadonlyMap<string, string>;
}

interface UseSidebarThreadPrStatusResult {
  readonly visibleSidebarThreadIds: readonly ThreadId[];
  readonly prByThreadId: ReadonlyMap<ThreadId, GitStatusResult["pr"]>;
}

export function useSidebarThreadPrStatus(
  input: UseSidebarThreadPrStatusInput,
): UseSidebarThreadPrStatusResult {
  const visibleSidebarThreadIds = getVisibleSidebarThreadIds(input.renderedProjects);
  const visibleSidebarThreads = visibleSidebarThreadIds.flatMap((threadId) => {
    const thread = input.sidebarThreadsById[threadId];
    return thread ? [thread] : [];
  });
  const threadGitTargets = visibleSidebarThreads.map((thread) => ({
    threadId: thread.id,
    branch: thread.branch,
    cwd: thread.worktreePath ?? input.projectCwdById.get(thread.projectId) ?? null,
  }));
  const threadGitStatusCwds = [];
  const threadGitStatusCwdSet = new Set<string>();
  for (const target of threadGitTargets) {
    if (target.branch !== null && target.cwd !== null && !threadGitStatusCwdSet.has(target.cwd)) {
      threadGitStatusCwdSet.add(target.cwd);
      threadGitStatusCwds.push(target.cwd);
    }
  }
  const threadGitStatusQueries = useQueries({
    queries: threadGitStatusCwds.map((cwd) => ({
      ...gitStatusQueryOptions(cwd),
      staleTime: 30_000,
      refetchInterval: 60_000,
    })),
  });
  const statusByCwd = new Map<string, GitStatusResult>();
  for (let index = 0; index < threadGitStatusCwds.length; index += 1) {
    const cwd = threadGitStatusCwds[index];
    if (!cwd) continue;
    const status = threadGitStatusQueries[index]?.data;
    if (status) {
      statusByCwd.set(cwd, status);
    }
  }

  const prByThreadId = new Map<ThreadId, GitStatusResult["pr"]>();
  for (const target of threadGitTargets) {
    const status = target.cwd ? statusByCwd.get(target.cwd) : undefined;
    const branchMatches =
      target.branch !== null && status?.branch !== null && status?.branch === target.branch;
    prByThreadId.set(target.threadId, branchMatches ? (status?.pr ?? null) : null);
  }

  return {
    visibleSidebarThreadIds,
    prByThreadId,
  };
}
