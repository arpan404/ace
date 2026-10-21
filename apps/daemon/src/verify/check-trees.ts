import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { VerifyGit } from "./ports.ts";
import type { VerifyRuns, VerifyTree } from "./run-store.ts";

/** The key prefix of a run's local merges (`GitService.integrate` receipts). */
export function integrationPrefix(runId: string): string {
  return `verify-${runId}.`;
}

/**
 * Verify's temporary worktrees: ace-owned, one per run under `root`, never a thread's. Each is
 * journalled before Git creates it, so a crash at any point leaves something `remove` can find.
 */
export class CheckTrees {
  private readonly git: VerifyGit;
  private readonly runs: VerifyRuns;
  private readonly root: string;
  constructor(git: VerifyGit, runs: VerifyRuns, root: string) {
    this.git = git;
    this.runs = runs;
    this.root = root;
  }

  /** A checkout of `baseRef` on a throwaway branch, Git hooks off. */
  async create(input: {
    runId: string;
    repo: string;
    baseRef: string;
    signal: AbortSignal;
  }): Promise<VerifyTree> {
    const tree: VerifyTree = {
      runId: input.runId,
      repo: input.repo,
      path: join(this.root, input.runId),
      branch: `ace-verify/${input.runId}`,
    };
    this.runs.journalTree(tree);
    await mkdir(this.root, { recursive: true });
    await this.git.nonExecuting(() =>
      this.git.createWorktree({
        repo: tree.repo,
        path: tree.path,
        baseRef: input.baseRef,
        branch: tree.branch,
        signal: input.signal,
      }),
    );
    return tree;
  }

  /** Remove the checkout, its branch and its merge receipts; each part tolerates being gone. */
  async remove(tree: VerifyTree): Promise<void> {
    const { repo, path, branch } = tree;
    await this.git
      .nonExecuting(() => this.git.removeWorktree({ repo, path, force: true }))
      .catch(() => {});
    await rm(path, { recursive: true, force: true });
    await this.git.pruneWorktrees(repo).catch(() => {});
    const head = await this.git.branchHead({ repo, branch }).catch(() => undefined);
    if (head)
      await this.git.deleteBranch({ repo, branch, expectedHead: head }).catch(() => undefined);
    await this.git
      .forgetIntegrations({ repo, prefix: integrationPrefix(tree.runId) })
      .catch(() => undefined);
    this.runs.forgetTree(tree.runId);
  }

  /** After a restart: remove every journalled tree whose run is not running in this daemon. */
  async sweep(isLive: (runId: string) => boolean): Promise<void> {
    for (const tree of this.runs.trees()) if (!isLive(tree.runId)) await this.remove(tree);
  }
}
