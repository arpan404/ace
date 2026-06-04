import {
  type GitActionProgressEvent,
  type GitRunStackedActionInput,
  type GitStackedAction,
} from "@ace/contracts";
import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import { ensureNativeApi } from "../nativeApi";
import { getWsRpcClient } from "../wsRpcClient";
import { withRpcRouteConnection } from "./connectionRouting";

const GIT_STATUS_STALE_TIME_MS = 5_000;
const GIT_STATUS_REFETCH_INTERVAL_MS = 15_000;
const GIT_WORKING_TREE_DIFF_STALE_TIME_MS = 1_000;
const GIT_BRANCHES_STALE_TIME_MS = 15_000;
const GIT_BRANCHES_REFETCH_INTERVAL_MS = 60_000;
const GIT_WORKTREE_STATS_STALE_TIME_MS = 5 * 60_000;
const GIT_GITHUB_ISSUES_STALE_TIME_MS = 30_000;
export type GitHubIssueListStateFilter = "open" | "closed" | "all";

export const gitQueryKeys = {
  all: ["git"] as const,
  status: (cwd: string | null, connectionUrl?: string | null) =>
    ["git", "status", connectionUrl ?? null, cwd] as const,
  workingTreeDiff: (
    cwd: string | null,
    connectionUrl?: string | null,
    relativePath?: string | null,
  ) => ["git", "working-tree-diff", connectionUrl ?? null, cwd, relativePath ?? null] as const,
  branches: (cwd: string | null, connectionUrl?: string | null) =>
    ["git", "branches", connectionUrl ?? null, cwd] as const,
  worktreeStats: (paths: readonly string[], connectionUrl?: string | null) =>
    ["git", "worktree-stats", connectionUrl ?? null, paths.join("\u0000")] as const,
  githubIssues: (
    cwd: string | null,
    limit: number,
    state: GitHubIssueListStateFilter,
    labels: readonly string[],
    query: string | null,
  ) => ["git", "github-issues", cwd, limit, state, labels.join("|"), query] as const,
  githubIssueThread: (cwd: string | null, issueNumber: number | null) =>
    ["git", "github-issue-thread", cwd, issueNumber] as const,
};

export const gitMutationKeys = {
  init: (cwd: string | null) => ["git", "mutation", "init", cwd] as const,
  checkout: (cwd: string | null) => ["git", "mutation", "checkout", cwd] as const,
  runStackedAction: (cwd: string | null) => ["git", "mutation", "run-stacked-action", cwd] as const,
  pull: (cwd: string | null) => ["git", "mutation", "pull", cwd] as const,
  preparePullRequestThread: (cwd: string | null) =>
    ["git", "mutation", "prepare-pull-request-thread", cwd] as const,
};

export function invalidateGitQueries(queryClient: QueryClient, input?: { cwd?: string | null }) {
  const cwd = input?.cwd ?? null;
  if (cwd !== null) {
    return queryClient.invalidateQueries({
      predicate: (query) => {
        const queryKey = query.queryKey;
        return (
          queryKey[0] === "git" &&
          (queryKey[1] === "status" || queryKey[1] === "branches") &&
          queryKey[3] === cwd
        );
      },
    });
  }

  return queryClient.invalidateQueries({ queryKey: gitQueryKeys.all });
}

export function invalidateGitStatusQuery(queryClient: QueryClient, cwd: string | null) {
  if (cwd === null) {
    return Promise.resolve();
  }

  return queryClient.invalidateQueries({ queryKey: gitQueryKeys.status(cwd) });
}

export function invalidateGitWorktreeStatsQueries(queryClient: QueryClient) {
  return queryClient.invalidateQueries({
    predicate: (query) => query.queryKey[0] === "git" && query.queryKey[1] === "worktree-stats",
  });
}

export function gitStatusQueryOptions(cwd: string | null, connectionUrl?: string | null) {
  return queryOptions({
    queryKey: gitQueryKeys.status(cwd, connectionUrl),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!cwd) throw new Error("Git status is unavailable.");
      return api.git.status(withRpcRouteConnection({ cwd }, connectionUrl));
    },
    enabled: cwd !== null,
    staleTime: GIT_STATUS_STALE_TIME_MS,
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
    refetchInterval: GIT_STATUS_REFETCH_INTERVAL_MS,
  });
}

export function gitWorkingTreeDiffQueryOptions(input: {
  connectionUrl?: string | null | undefined;
  cwd: string | null;
  enabled?: boolean;
  relativePath?: string | null;
}) {
  return queryOptions({
    queryKey: gitQueryKeys.workingTreeDiff(input.cwd, input.connectionUrl, input.relativePath),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Working tree diff is unavailable.");
      return api.git.readWorkingTreeDiff(
        withRpcRouteConnection(
          {
            cwd: input.cwd,
            ...(input.relativePath ? { relativePath: input.relativePath } : {}),
          },
          input.connectionUrl,
        ),
      );
    },
    enabled: (input.enabled ?? true) && input.cwd !== null,
    staleTime: GIT_WORKING_TREE_DIFF_STALE_TIME_MS,
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
  });
}

export function gitBranchesQueryOptions(cwd: string | null, connectionUrl?: string | null) {
  return queryOptions({
    queryKey: gitQueryKeys.branches(cwd, connectionUrl),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!cwd) throw new Error("Git branches are unavailable.");
      return api.git.listBranches(withRpcRouteConnection({ cwd }, connectionUrl));
    },
    enabled: cwd !== null,
    staleTime: GIT_BRANCHES_STALE_TIME_MS,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchInterval: GIT_BRANCHES_REFETCH_INTERVAL_MS,
  });
}

export function gitWorktreeStatsQueryOptions(input: {
  connectionUrl?: string | null | undefined;
  paths: readonly string[];
}) {
  const paths = Array.from(new Set(input.paths)).toSorted((left, right) =>
    left.localeCompare(right),
  );
  return queryOptions({
    queryKey: gitQueryKeys.worktreeStats(paths, input.connectionUrl),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (paths.length === 0) {
        return { worktrees: [] };
      }
      return api.git.getWorktreeStats(withRpcRouteConnection({ paths }, input.connectionUrl));
    },
    enabled: paths.length > 0,
    placeholderData: (previous) => previous,
    staleTime: GIT_WORKTREE_STATS_STALE_TIME_MS,
    gcTime: 30 * 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
  });
}

export function gitGitHubIssuesQueryOptions(input: {
  cwd: string | null;
  limit?: number;
  state?: GitHubIssueListStateFilter;
  labels?: readonly string[];
  query?: string;
  enabled?: boolean;
}) {
  const limit = input.limit ?? 50;
  const state = input.state ?? "open";
  const labels: string[] = [];
  for (const label of input.labels ?? []) {
    const normalizedLabel = label.trim();
    if (normalizedLabel.length > 0) {
      labels.push(normalizedLabel);
    }
  }
  labels.sort((left, right) => left.localeCompare(right));
  const query = input.query?.trim() ?? "";
  return queryOptions({
    queryKey: gitQueryKeys.githubIssues(
      input.cwd,
      limit,
      state,
      labels,
      query.length > 0 ? query : null,
    ),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("GitHub issues are unavailable.");
      return api.git.listGitHubIssues({
        cwd: input.cwd,
        limit,
        state,
        ...(labels.length > 0 ? { labels } : {}),
        ...(query.length > 0 ? { query } : {}),
      });
    },
    enabled: (input.enabled ?? true) && input.cwd !== null,
    staleTime: GIT_GITHUB_ISSUES_STALE_TIME_MS,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
  });
}

export function gitGitHubIssueThreadQueryOptions(input: {
  cwd: string | null;
  issueNumber: number | null;
  enabled?: boolean;
}) {
  return queryOptions({
    queryKey: gitQueryKeys.githubIssueThread(input.cwd, input.issueNumber),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd || typeof input.issueNumber !== "number") {
        throw new Error("GitHub issue thread is unavailable.");
      }
      return api.git.getGitHubIssueThread({
        cwd: input.cwd,
        issueNumber: input.issueNumber,
      });
    },
    enabled: (input.enabled ?? true) && input.cwd !== null && typeof input.issueNumber === "number",
    staleTime: GIT_GITHUB_ISSUES_STALE_TIME_MS,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
  });
}

export function gitResolvePullRequestQueryOptions(input: {
  cwd: string | null;
  reference: string | null;
}) {
  return queryOptions({
    queryKey: ["git", "pull-request", input.cwd, input.reference] as const,
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd || !input.reference) {
        throw new Error("Pull request lookup is unavailable.");
      }
      return api.git.resolvePullRequest({ cwd: input.cwd, reference: input.reference });
    },
    enabled: input.cwd !== null && input.reference !== null,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

export function gitInitMutationOptions(input: {
  connectionUrl?: string | null | undefined;
  cwd: string | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: gitMutationKeys.init(input.cwd),
    mutationFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Git init is unavailable.");
      return api.git.init(withRpcRouteConnection({ cwd: input.cwd }, input.connectionUrl));
    },
    onSuccess: async () => {
      await invalidateGitQueries(input.queryClient);
    },
  });
}

function gitCheckoutMutationOptions(input: {
  connectionUrl?: string | null | undefined;
  cwd: string | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: gitMutationKeys.checkout(input.cwd),
    mutationFn: async (branch: string) => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Git checkout is unavailable.");
      return api.git.checkout(
        withRpcRouteConnection({ cwd: input.cwd, branch }, input.connectionUrl),
      );
    },
    onSuccess: async () => {
      await invalidateGitQueries(input.queryClient);
    },
  });
}

export function gitRunStackedActionMutationOptions(input: {
  cwd: string | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: gitMutationKeys.runStackedAction(input.cwd),
    mutationFn: async ({
      actionId,
      action,
      commitMessage,
      featureBranch,
      filePaths,
      modelSelection,
      onProgress,
    }: {
      actionId: string;
      action: GitStackedAction;
      commitMessage?: string;
      featureBranch?: boolean;
      filePaths?: string[];
      modelSelection?: GitRunStackedActionInput["modelSelection"];
      onProgress?: (event: GitActionProgressEvent) => void;
    }) => {
      if (!input.cwd) throw new Error("Git action is unavailable.");
      return getWsRpcClient().git.runStackedAction(
        {
          actionId,
          cwd: input.cwd,
          action,
          ...(commitMessage ? { commitMessage } : {}),
          ...(featureBranch ? { featureBranch } : {}),
          ...(filePaths ? { filePaths } : {}),
          ...(modelSelection ? { modelSelection } : {}),
        },
        ...(onProgress ? [{ onProgress }] : []),
      );
    },
    onSettled: async () => {
      await invalidateGitQueries(input.queryClient);
    },
  });
}

export function gitPullMutationOptions(input: {
  connectionUrl?: string | null | undefined;
  cwd: string | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: gitMutationKeys.pull(input.cwd),
    mutationFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Git pull is unavailable.");
      return api.git.pull(withRpcRouteConnection({ cwd: input.cwd }, input.connectionUrl));
    },
    onSettled: async () => {
      await invalidateGitQueries(input.queryClient);
    },
  });
}

export function gitCreateWorktreeMutationOptions(input: { queryClient: QueryClient }) {
  return mutationOptions({
    mutationFn: async ({
      cwd,
      branch,
      newBranch,
      connectionUrl,
      path,
    }: {
      cwd: string;
      branch: string;
      newBranch: string;
      connectionUrl?: string | null;
      path?: string | null;
    }) => {
      const api = ensureNativeApi();
      if (!cwd) throw new Error("Git worktree creation is unavailable.");
      return api.git.createWorktree(
        withRpcRouteConnection({ cwd, branch, newBranch, path: path ?? null }, connectionUrl),
      );
    },
    mutationKey: ["git", "mutation", "create-worktree"] as const,
    onSettled: async () => {
      await Promise.all([
        invalidateGitQueries(input.queryClient),
        invalidateGitWorktreeStatsQueries(input.queryClient),
      ]);
    },
  });
}

export function gitRemoveWorktreeMutationOptions(input: { queryClient: QueryClient }) {
  return mutationOptions({
    mutationFn: async ({
      connectionUrl,
      cwd,
      path,
      force,
    }: {
      connectionUrl?: string | null;
      cwd: string;
      path: string;
      force?: boolean;
    }) => {
      const api = ensureNativeApi();
      if (!cwd) throw new Error("Git worktree removal is unavailable.");
      return api.git.removeWorktree(withRpcRouteConnection({ cwd, path, force }, connectionUrl));
    },
    mutationKey: ["git", "mutation", "remove-worktree"] as const,
    onSettled: async () => {
      await Promise.all([
        invalidateGitQueries(input.queryClient),
        invalidateGitWorktreeStatsQueries(input.queryClient),
      ]);
    },
  });
}

export function gitPreparePullRequestThreadMutationOptions(input: {
  cwd: string | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationFn: async ({ reference, mode }: { reference: string; mode: "local" | "worktree" }) => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Pull request thread preparation is unavailable.");
      return api.git.preparePullRequestThread({
        cwd: input.cwd,
        reference,
        mode,
      });
    },
    mutationKey: gitMutationKeys.preparePullRequestThread(input.cwd),
    onSettled: async () => {
      await invalidateGitQueries(input.queryClient);
    },
  });
}
