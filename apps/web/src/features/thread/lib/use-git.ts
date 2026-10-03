import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useThreadSources, type ThreadRef } from "../sources/index.ts";
import type { GitAction, GitState } from "../sources/workspace-source.ts";

type Change =
  | { kind: "action"; action: GitAction }
  | { kind: "branch"; branch: string }
  | { kind: "mode"; mode: GitState["mode"] };

/**
 * The thread checkout's git and PR state: a request/response read, so it lives in TanStack
 * Query. Every change returns the new state, which replaces the cached one.
 */
export function useGit(thread: ThreadRef) {
  const sources = useThreadSources();
  const queryClient = useQueryClient();
  const key = ["thread", "git", thread.id];
  const query = useQuery({ queryKey: key, queryFn: () => sources.workspace.git(thread) });
  const mutation = useMutation({
    mutationFn: (change: Change) => {
      switch (change.kind) {
        case "action":
          return sources.workspace.gitAction(thread, change.action);
        case "branch":
          return sources.workspace.switchBranch(thread, change.branch);
        case "mode":
          return sources.workspace.setMode(thread, change.mode);
      }
    },
    onSuccess: (state) => queryClient.setQueryData(key, state),
  });
  return { git: query.data, change: mutation.mutateAsync, pending: mutation.isPending };
}
