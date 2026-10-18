import type { CommandPayload, WorkspaceActionResult } from "@ace/protocol";
import { fakeBranchRefs } from "./worktree-base.ts";

/** How a worktree start fails, as the daemon reports it on the progress and the receipt. */
export interface FakeCreationFailure {
  error: string;
  title: string;
  detail: string;
  lockPath?: string;
  /** The step it fails at: before anything is made, or after checkout in the setup script. */
  step: "preparing" | "setup";
  /** The script's output, for a setup failure. */
  output: readonly string[];
}

type Branches = WorkspaceActionResult["result"];

/*
 * The fake projects' repositories as Git would find them: a folder that isn't a repository, a
 * repository with no commits yet, a stale lock from an earlier daemon, or a setup script that
 * fails. Each fact is set by a test and read by `branches.list` and worktree starts. Per
 * thread, a remote branch that moved on (after a rebase) and a checkout whose hooks won't run.
 */
export class FakeGitStates {
  private kinds = new Map<string, "none" | "empty" | "detached">();
  private locks = new Map<string, string>();
  private setups = new Map<string, readonly string[]>();
  /** Per thread, the remote branch's revision when it has commits the checkout doesn't. */
  private diverged = new Map<string, string>();
  private hooksSkipped = new Set<string>();
  private defaults = new Map<string, string>();

  /**
   * The remote branch has commits the thread's checkout lacks (after a rebase or amend): a plain
   * push is rejected with the remote's revision, and only a force push leased to it goes through.
   */
  setRemoteDiverged(threadId: string, remoteHead: string): void {
    this.diverged.set(threadId, remoteHead);
  }
  /** The person's commits in the thread's checkout won't run Git hooks (a PR review worktree). */
  setHooksSkipped(threadId: string): void {
    this.hooksSkipped.add(threadId);
  }
  /** What `git.status` says about hooks for the thread's checkout. */
  hooks(threadId: string): "run" | "skipped" {
    return this.hooksSkipped.has(threadId) ? "skipped" : "run";
  }
  /** How `git.push` refuses, if it does; a push that goes through brings the remote level. */
  pushRefusal(
    threadId: string,
    force: { lease: string } | undefined,
  ): { ok: false; error: string; remoteHead?: string } | undefined {
    const remoteHead = this.diverged.get(threadId);
    if (remoteHead && !force) return { ok: false, error: "git_push_rejected", remoteHead };
    if (remoteHead && force?.lease !== remoteHead)
      return { ok: false, error: "git_push_lease_stale" };
    this.diverged.delete(threadId);
    return undefined;
  }

  /**
   * The project's folder isn't a Git repository (`none`), has no commits yet (`empty`), or sits
   * on a detached HEAD with commits but no branches (`detached`).
   */
  setRepository(workspaceId: string, kind: "repo" | "none" | "empty" | "detached"): void {
    if (kind === "repo") this.kinds.delete(workspaceId);
    else this.kinds.set(workspaceId, kind);
  }
  /** A stale Git lock fences the project's repository until `workspace.git.lock.clear`. */
  lock(workspaceId: string, repository: string): void {
    this.locks.set(workspaceId, repository);
  }
  /** The repository's default branch, as `branches.list` reports it ("main" unless set). */
  setDefaultBranch(workspaceId: string, name: string): void {
    this.defaults.set(workspaceId, name);
  }
  /** Every worktree start in the project fails its setup script with `output`, or no longer. */
  failSetup(workspaceId: string, output: readonly string[] | undefined): void {
    if (output) this.setups.set(workspaceId, output);
    else this.setups.delete(workspaceId);
  }
  /** `workspace.git.lock.clear`: the lock's owner is gone in the fixture, so it clears. */
  clearLock(workspaceId: string): boolean {
    return this.locks.delete(workspaceId);
  }

  /** What `branches.list` answers for the project. */
  branches(workspaceId: string): Branches {
    const kind = this.kinds.get(workspaceId);
    if (kind === "none") return { kind: "error", code: "git_not_a_repo" };
    if (kind === "empty")
      return {
        kind: "branches",
        branches: [],
        truncated: false,
        refs: [],
        defaultBranch: "main",
        unbornHead: true,
      };
    if (kind === "detached")
      return { kind: "branches", branches: [], truncated: false, refs: [], unbornHead: false };
    return {
      kind: "branches",
      branches: ["main", "develop"],
      truncated: false,
      refs: [...fakeBranchRefs],
      defaultBranch: this.defaults.get(workspaceId) ?? "main",
    };
  }

  /** Why a worktree start in the payload's project fails, if it does. */
  creationFailure(payload: CommandPayload): FakeCreationFailure | undefined {
    if (payload.type !== "thread.create" && payload.type !== "thread.prepare") return undefined;
    const id = payload.workspaceId;
    const lockPath = this.locks.get(id);
    if (lockPath)
      return {
        error: "git_quarantined",
        title: "Git is locked",
        detail: `A stale Git lock from an earlier ace daemon fences ${lockPath}.`,
        lockPath,
        step: "preparing",
        output: [],
      };
    const kind = this.kinds.get(id);
    if (kind === "none")
      return {
        error: "not_a_repo",
        title: "Not a Git repository",
        detail: "This project isn't a Git repository, so it can't have worktrees.",
        step: "preparing",
        output: [],
      };
    if (kind === "empty")
      return {
        error: "no_commits",
        title: "No commits yet",
        detail: "A worktree needs a commit to start from.",
        step: "preparing",
        output: [],
      };
    const output = this.setups.get(id);
    if (output)
      return {
        error: "setup_failed",
        title: "Setup script failed",
        detail: "The worktree is ready but its setup script failed.",
        step: "setup",
        output,
      };
    return undefined;
  }
}
