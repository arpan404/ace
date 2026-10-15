import { WorkspaceId, type BranchRef } from "@ace/protocol";
import { useDaemonQuery } from "@/lib/daemon-query.ts";

const defaults = ["main", "master", "trunk", "develop"];

/** The usual default branch first, then the rest as the daemon listed them. */
export function defaultFirst(branches: readonly string[]): string[] {
  const first = defaults.find((name) => branches.includes(name));
  return first ? [first, ...branches.filter((branch) => branch !== first)] : [...branches];
}

const none: readonly string[] = [];

/**
 * A project's branches, from the daemon's workspace service (`branches.list`), default branch
 * first; empty while loading or when the project's branches can't be read. New thread starts a
 * worktree from one; a thread's environment pill switches its checkout to one.
 */
export function useBranches(project: string | undefined, enabled = true): readonly string[] {
  return (
    useDaemonQuery({
      queryKey: ["project", "branches", project],
      enabled: enabled && project !== undefined,
      staleTime: 30_000,
      read: async (client, signal) => {
        const reply = await client.request(
          {
            type: "workspace.request",
            operation: { op: "branches.list", workspaceId: WorkspaceId.parse(project) },
          },
          { signal },
        );
        return reply.result.kind === "branches" ? defaultFirst(reply.result.branches) : none;
      },
    }).data ?? none
  );
}

/** What a worktree can start from: the project's branches told apart, local and remote. */
export interface BaseRefs {
  refs: readonly BranchRef[];
  /** The repository's default branch, when the daemon said. */
  defaultBranch: string | undefined;
  state: "loading" | "ready" | "failed";
  /**
   * Why the project can't have worktrees, once the branches are read: its folder isn't a Git
   * repository, or the repository has no commit to start from (no branch at all yet).
   */
  noWorktree: "not_a_repo" | "no_commits" | undefined;
}

const noRefs: readonly BranchRef[] = [];

/**
 * A project's branches for a new worktree's base (`branches.list`): local ones with how far they
 * are from their upstream, and the remotes' ones. A daemon that lists names only (before `refs`)
 * gives local names; the base is then sent as a name too, which such a daemon understands.
 */
export function useBaseRefs(project: string | undefined): BaseRefs {
  const query = useDaemonQuery({
    queryKey: ["project", "base-refs", project],
    enabled: project !== undefined,
    staleTime: 30_000,
    read: async (client, signal) => {
      const reply = await client.request(
        {
          type: "workspace.request",
          operation: { op: "branches.list", workspaceId: WorkspaceId.parse(project) },
        },
        { signal },
      );
      const result = reply.result;
      if (result.kind === "error" && result.code === "git_not_a_repo")
        return { refs: noRefs, defaultBranch: undefined, repository: "not_a_repo" as const };
      if (result.kind !== "branches") throw new Error("ace didn't list the branches.");
      const refs: readonly BranchRef[] = result.refs ?? result.branches.map((name) => ({ name }));
      const empty = !result.branches.length && !refs.some((ref) => !ref.remote);
      return {
        refs,
        defaultBranch: result.defaultBranch,
        repository: empty ? ("no_commits" as const) : undefined,
      };
    },
  });
  return {
    refs: query.data?.refs ?? noRefs,
    defaultBranch: query.data?.defaultBranch,
    state: query.data ? "ready" : query.isError ? "failed" : "loading",
    noWorktree: query.data?.repository,
  };
}
