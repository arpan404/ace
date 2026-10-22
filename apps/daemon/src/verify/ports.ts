import type { GitService } from "@ace/git";
import type { ForgePrRef, ForgeRepository, WorkspaceId } from "@ace/protocol";

/** The Git a run needs: the daemon's one GitService, so its leases cover runs too. */
export type VerifyGit = Pick<
  GitService,
  | "nonExecuting"
  | "fetchBranch"
  | "branchHead"
  | "fetchPrHead"
  | "createWorktree"
  | "integrate"
  | "forgetIntegrations"
  | "setupWorktree"
  | "removeWorktree"
  | "pruneWorktrees"
  | "deleteBranch"
>;

/** How one GitHub merge ended. `refused`: it certainly did not merge. */
export type VerifyMergeOutcome =
  | { outcome: "merged" }
  | { outcome: "refused"; message: string }
  | { outcome: "uncertain" };

/** GitHub, reached through the daemon's forge (the person's own `gh`). */
export interface VerifyForge {
  /** The remote that serves `repository`'s pull requests in the checkout at `project`. */
  remote(project: string, repository: ForgeRepository, signal: AbortSignal): Promise<string>;
  /** A PR's base branch, refusing (`ForgeError` `head_moved`) a head that moved. */
  base(project: string, pr: ForgePrRef, headSha: string, signal: AbortSignal): Promise<string>;
  /** The numbers among `numbers` that belong to a GitHub stack. */
  stacked(
    project: string,
    workspaceId: WorkspaceId,
    repository: ForgeRepository,
    numbers: readonly number[],
    signal: AbortSignal,
  ): Promise<number[]>;
  /** Merge through the hosted merge path (its write journal and fence), pinned to `headSha`. */
  merge(input: {
    project: string;
    workspaceId: WorkspaceId;
    runId: string;
    /** 1 for the first try; a retry after a refusal is a new write with its own id. */
    attempt: number;
    pr: ForgePrRef;
    headSha: string;
    method: "merge" | "squash" | "rebase";
    allowed: () => boolean;
  }): Promise<VerifyMergeOutcome>;
  /** The numbers among `numbers` GitHub reports merged. */
  merged(
    project: string,
    repository: ForgeRepository,
    numbers: readonly number[],
    signal: AbortSignal,
  ): Promise<number[]>;
}
