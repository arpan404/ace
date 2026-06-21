/**
 * GitManager - Effect service contract for stacked Git workflows.
 *
 * Orchestrates status inspection and commit/push/PR flows by composing
 * lower-level Git and external tool services.
 *
 * @module GitManager
 */
import {
  GitActionProgressEvent,
  GitGetGitHubIssueThreadInput,
  GitGetGitHubIssueThreadResult,
  GitListGitHubIssuesInput,
  GitListGitHubIssuesResult,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  GitPullRequestRefInput,
  GitResolvePullRequestResult,
  GitRunStackedActionInput,
  GitRunStackedActionResult,
  GitStatusInput,
  GitStatusResult,
  GitWorkingTreeDiffInput,
  GitWorkingTreeDiffResult,
} from "@ace/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";
import type { GitManagerServiceError } from "@ace/contracts";

export interface GitActionProgressReporter {
  readonly publish: (event: GitActionProgressEvent) => Effect.Effect<void, never>;
}

export interface GitRunStackedActionOptions {
  readonly actionId?: string;
  readonly progressReporter?: GitActionProgressReporter;
}

/**
 * GitManagerShape - Service API for high-level Git workflow actions.
 */
export interface GitManagerShape {
  /**
   * Read current repository Git status plus open PR metadata when available.
   */
  readonly status: (
    input: GitStatusInput,
  ) => Effect.Effect<GitStatusResult, GitManagerServiceError>;

  /**
   * Read the current working tree patch diff relative to HEAD.
   */
  readonly readWorkingTreeDiff: (
    input: GitWorkingTreeDiffInput,
  ) => Effect.Effect<GitWorkingTreeDiffResult, GitManagerServiceError>;

  /**
   * Resolve a pull request by URL/number against the current repository.
   */
  readonly resolvePullRequest: (
    input: GitPullRequestRefInput,
  ) => Effect.Effect<GitResolvePullRequestResult, GitManagerServiceError>;

  /**
   * List open GitHub issues for the repository at the provided cwd.
   */
  readonly listGitHubIssues: (
    input: GitListGitHubIssuesInput,
  ) => Effect.Effect<GitListGitHubIssuesResult, GitManagerServiceError>;

  /**
   * Fetch full GitHub issue thread context by issue number.
   */
  readonly getGitHubIssueThread: (
    input: GitGetGitHubIssueThreadInput,
  ) => Effect.Effect<GitGetGitHubIssueThreadResult, GitManagerServiceError>;

  /**
   * Prepare a new thread workspace from a pull request in local or worktree mode.
   */
  readonly preparePullRequestThread: (
    input: GitPreparePullRequestThreadInput,
  ) => Effect.Effect<GitPreparePullRequestThreadResult, GitManagerServiceError>;

  /**
   * Run a Git action (`commit`, `push`, `create_pr`, `commit_push`, `commit_push_pr`).
   * When `featureBranch` is set, creates and checks out a feature branch first.
   */
  readonly runStackedAction: (
    input: GitRunStackedActionInput,
    options?: GitRunStackedActionOptions,
  ) => Effect.Effect<GitRunStackedActionResult, GitManagerServiceError>;
}

/**
 * GitManager - Service tag for stacked Git workflow orchestration.
 */
export class GitManager extends ServiceMap.Service<GitManager, GitManagerShape>()(
  "ace/git/Services/GitManager",
) {}
