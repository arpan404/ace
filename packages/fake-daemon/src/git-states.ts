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
 * fails. Each fact is set by a test and read by `branches.list` and worktree starts.
 */
export class FakeGitStates {
  private kinds = new Map<string, "none" | "empty">();
  private locks = new Map<string, string>();
  private setups = new Map<string, readonly string[]>();

  /** The project's folder isn't a Git repository (`none`), or has no commits yet (`empty`). */
  setRepository(workspaceId: string, kind: "repo" | "none" | "empty"): void {
    if (kind === "repo") this.kinds.delete(workspaceId);
    else this.kinds.set(workspaceId, kind);
  }
  /** A stale Git lock fences the project's repository until `workspace.git.lock.clear`. */
  lock(workspaceId: string, repository: string): void {
    this.locks.set(workspaceId, repository);
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
      return { kind: "branches", branches: [], truncated: false, refs: [], defaultBranch: "main" };
    return {
      kind: "branches",
      branches: ["main", "develop"],
      truncated: false,
      refs: [...fakeBranchRefs],
      defaultBranch: "main",
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
