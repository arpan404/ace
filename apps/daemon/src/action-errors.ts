import { ForgeError } from "@ace/forge";
import { GitError, isMutationUnavailable } from "@ace/git";
import { WorkspaceChangeRefused } from "./engine/workspace-change.ts";

/** Fixed public codes only; process output and arbitrary exception messages stay private. */
export function actionErrorCode(error: unknown): string {
  if (error instanceof ForgeError) return `forge_${error.kind}`;
  if (error instanceof WorkspaceChangeRefused) return error.code;
  if (error instanceof GitError)
    return isMutationUnavailable(error)
      ? "git_quarantined"
      : `git_${error.code.replace(/^git_/, "")}`;
  if (
    error instanceof Error &&
    [
      "draft_provider_unavailable",
      "draft_provider_failed",
      "draft_invalid_output",
      "draft_timeout",
      "draft_cancelled",
      "draft_busy",
      "draft_changes_moved",
      "draft_guard_unavailable",
      "workspace_busy",
      "thread_creation_in_progress",
      "workspace_preparation_collision",
      "workspace_change_refused",
      "repository_mismatch",
      "git_pr_head_unavailable",
      "pr_checkout_changed",
      "pr_requires_worktree",
      "workspace_cleanup_required",
      "issue_reconciliation_required",
      "action_outcome_uncertain",
      "forge_write_pending",
      "workspace_not_found",
      "pr_link_changed",
      "forge_recovery_unavailable",
      "forbidden",
      "thread_tree_is_live",
      "terminal_owned",
      "workspace_change_in_progress",
      "workspace_preparing",
      "workspace_root_changed",
      "thread_not_found",
      "engine_unavailable",
      "script_not_found",
      "script_shell_unsupported",
      "editor_not_found",
      "terminal_limit",
    ].includes(error.message)
  )
    return error.message;
  return "action_failed";
}

/**
 * A failed workspace read's public code. A forge read that fails for a reason without its own
 * code still says it was GitHub that couldn't be read, never the daemon's general failure.
 */
export function readErrorCode(op: string, error: unknown): string {
  const code = actionErrorCode(error);
  return code === "action_failed" && op.startsWith("forge.") ? "forge_read_failed" : code;
}

/** A rejected push's remote-tracking revision, which a person may lease a force push to. */
export function rejectedRemoteHead(error: unknown): string | undefined {
  if (!(error instanceof GitError) || error.code !== "push_rejected") return undefined;
  const head = error.details.remoteHead;
  return typeof head === "string" && /^[a-f0-9]{40,64}$/.test(head) ? head : undefined;
}
