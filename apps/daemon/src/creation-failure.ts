import { GitError, isMutationUnavailable } from "@ace/git";
import { actionErrorCode } from "./action-errors.ts";
import { WorktreeBaseError } from "./worktree-base-resolution.ts";

export type CreationErrorCode = "no_commits" | "setup_failed" | "preparation_timeout";

/** A creation failure the daemon itself names, with no Git error behind its code. */
export class CreationError extends Error {
  readonly code: CreationErrorCode;
  constructor(code: CreationErrorCode, options?: { cause?: unknown }) {
    super(code, options);
    this.code = code;
  }
}

/** What a failed worktree start reports: a fixed code, readable text, and a lock to clear. */
export interface CreationFailure {
  error: string;
  title: string;
  detail: string;
  lockPath?: string;
}

const local = "Try again or use the local checkout.";
const texts: Record<string, { title: string; detail: string }> = {
  git_quarantined: {
    title: "Git is locked",
    detail: "An interrupted Git operation still fences this repository.",
  },
  not_a_repo: {
    title: "Not a Git repository",
    detail:
      "This project isn't a Git repository, so it can't have worktrees. Use the local checkout.",
  },
  no_commits: {
    title: "No commits yet",
    detail: "A worktree needs a commit to start from. Commit once, or use the local checkout.",
  },
  invalid_ref: {
    title: "Base not found",
    detail: `The base to start from doesn't exist. ${local}`,
  },
  branch_exists: {
    title: "Branch already exists",
    detail: `The worktree's branch already exists. ${local}`,
  },
  branch_checked_out: {
    title: "Branch in use",
    detail: `The branch is already checked out in another worktree. ${local}`,
  },
  path_exists: {
    title: "Worktree folder in use",
    detail: `Something already exists where the worktree goes. ${local}`,
  },
  ref_conflict: {
    title: "Branch name conflict",
    detail: `Git couldn't create the worktree's branch because another ref is in the way. ${local}`,
  },
  workspace_preparation_collision: {
    title: "Worktree folder in use",
    detail: `Another checkout already uses this worktree's folder or branch. ${local}`,
  },
  setup_failed: {
    title: "Setup script failed",
    detail:
      "The worktree is ready but its setup script failed. Retry setup, continue without it, or use the local checkout.",
  },
  preparation_timeout: {
    title: "Worktree preparation timed out",
    detail: `Git didn't answer in time while preparing the worktree. ${local}`,
  },
  git_missing: { title: "Git not found", detail: "Install Git, or use the local checkout." },
  git_too_old: { title: "Git is too old", detail: "Update Git, or use the local checkout." },
  workspace_busy: {
    title: "Too many worktree starts",
    detail: "Wait for another worktree start to finish, then try again.",
  },
  workspace_cleanup_required: {
    title: "Cleanup needs attention",
    detail: "A previous worktree couldn't be cleaned up safely.",
  },
  workspace_not_found: {
    title: "Project not found",
    detail: "The project is no longer registered.",
  },
};
const passed = new Set([
  "workspace_busy",
  "workspace_preparation_collision",
  "workspace_cleanup_required",
  "workspace_not_found",
  "workspace_closed",
  "thread_creation_in_progress",
  "forge_recovery_unavailable",
  "pr_requires_worktree",
]);
const gitPassed = new Set([
  "not_a_repo",
  "invalid_ref",
  "branch_exists",
  "git_missing",
  "git_too_old",
  "auth_failed",
  "remote_unreachable",
  "git_timeout",
  "ref_conflict",
  "path_exists",
  "branch_checked_out",
]);

const found = (code: string, detail?: string, lockPath?: string): CreationFailure => ({
  error: code,
  title: texts[code]?.title ?? "Couldn't create the worktree",
  detail: detail ?? texts[code]?.detail ?? `We couldn't create the worktree. ${local}`,
  ...(lockPath ? { lockPath } : {}),
});

/**
 * The public code for a failed start. Arbitrary process output stays private; only Git's own
 * quarantine message, which names the locked repository, is passed on.
 */
export function creationFailure(error: unknown, pullRequest = false): CreationFailure {
  if (error instanceof WorktreeBaseError)
    return { error: error.code, title: error.title, detail: error.message };
  if (error instanceof CreationError) return found(error.code);
  if (error instanceof GitError && isMutationUnavailable(error)) {
    const repository = error.details.repository;
    return found(
      "git_quarantined",
      error.code === "git_quarantined" ? error.message.slice(0, 1024) : undefined,
      typeof repository === "string" ? repository : undefined,
    );
  }
  if (pullRequest) return found(actionErrorCode(error));
  if (error instanceof GitError) {
    if (error.code === "unborn_head") return found("no_commits");
    if (gitPassed.has(error.code)) return found(error.code);
    return found(`git_${error.code.replace(/^git_/, "")}`);
  }
  if (error instanceof Error && passed.has(error.message)) return found(error.message);
  return found("workspace_unavailable");
}
