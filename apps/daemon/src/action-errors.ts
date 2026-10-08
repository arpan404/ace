import { ForgeError } from "@ace/forge";
import { GitError, isMutationUnavailable } from "@ace/git";

/** Fixed public codes only; process output and arbitrary exception messages stay private. */
export function actionErrorCode(error: unknown): string {
  if (error instanceof ForgeError) return `forge_${error.kind}`;
  if (error instanceof GitError)
    return isMutationUnavailable(error)
      ? "git_quarantined"
      : `git_${error.code.replace(/^git_/, "")}`;
  if (
    error instanceof Error &&
    [
      "repository_mismatch",
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
