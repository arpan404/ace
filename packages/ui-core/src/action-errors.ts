/*
 * The daemon's git, forge, checkout and review refusal codes in words: what went wrong, then
 * after a colon what fixes it ("Sign in to GitHub: run `gh auth login`, then retry."). Commands
 * are in backticks for `InlineMarkdown`. A code without its own sentence gets a general one, never
 * the raw code. Pure.
 */

const copy: Record<string, string> = {
  // The daemon's own checkout and action refusals.
  forbidden: "This device may not change the checkout: ask for full access on the host.",
  workspace_preparing: "The thread's worktree is still being prepared: wait a moment, then retry.",
  workspace_root_changed: "The thread's worktree moved: try again.",
  workspace_not_found: "The thread's project is gone: open the project again.",
  workspace_unavailable: "The thread has no checkout yet: send it a message first.",
  workspace_change_in_progress: "The checkout is still moving: wait for it to finish, then retry.",
  thread_not_found: "The thread is gone: it may have been deleted on another device.",
  thread_tree_is_live: "Agents are working in the checkout: wait for them to stop, then retry.",
  terminal_owned: "The thread's terminals use the checkout: close them, then retry.",
  terminal_limit: "Too many terminals are open: close one, then retry.",
  script_not_found: "That script is no longer in the project: refresh the list.",
  script_shell_unsupported:
    "Scripts can't run on this daemon's platform yet: run it in a terminal.",
  editor_not_found: "That editor is no longer installed: pick another one.",
  engine_unavailable: "This daemon can't move a thread's checkout: update the daemon.",
  repository_mismatch: "The checkout's remote changed: refresh, then retry.",
  action_failed: "The daemon couldn't do that: check its logs, then retry.",
  action_busy: "Too many actions are running: wait for one to finish, then retry.",
  action_outcome_uncertain:
    "The daemon lost track of the result: check the checkout or GitHub before retrying.",
  pr_link_changed: "The linked pull request changed: refresh, then retry.",
  forge_recovery_unavailable:
    "This daemon can't find an existing PR: update the daemon, then retry.",
  // Git.
  git_missing: "Git isn't installed: install Git, then retry.",
  git_too_old: "This Git is too old: update Git, then retry.",
  git_failed: "Git couldn't finish that: run the same command in a terminal to see why.",
  git_head_moved: "The branch moved since you looked: refresh the changes, then retry.",
  git_conflicts: "Git found conflicts: resolve them in the checkout, then retry.",
  git_hook_failed: "A Git hook rejected the change: fix what the hook reports, then retry.",
  git_auth_failed:
    "Git couldn't sign in to the remote: check your SSH key or run `gh auth login`, then retry.",
  git_remote_unreachable:
    "Git couldn't reach the remote: check your connection and the remote's address, then retry.",
  git_remote_ref_not_found: "The branch isn't on the remote: push it first.",
  git_timeout: "Git took too long: retry, or run the command in a terminal.",
  git_cancelled: "The Git command was cancelled: try again.",
  git_closed: "The daemon stopped while Git was running: try again.",
  git_busy: "Another Git command is running in this checkout: wait for it, then retry.",
  git_quarantined: "Git cleanup is still pending: wait for it or restart the daemon, then retry.",
  git_malformed_output: "Git's output couldn't be read: update Git, then retry.",
  git_filesystem_error: "The checkout couldn't be written: check the disk and its permissions.",
  git_output_too_large: "Git's output is too large to read here: run the command in a terminal.",
  git_not_a_repo: "This folder isn't a Git repository: run `git init` or open a cloned project.",
  git_invalid_argument: "Git refused the request: check the branch and file names.",
  git_invalid_ref: "That branch doesn't exist in the project: fetch it or pick another.",
  git_branch_exists: "A branch with that name already exists: pick another name.",
  git_dirty_worktree:
    "The checkout has uncommitted changes: commit them, or bring them along to the branch.",
  git_worktree_not_found: "The thread's worktree is gone: move the thread to a new worktree.",
  git_main_worktree: "That is the project's own checkout: it can't be removed.",
  git_checkpoint_not_found: "That checkpoint is gone: pick a later one.",
  git_restore_collision: "Restoring would overwrite newer edits: commit or move them first.",
  git_unsupported_repository: "This repository's layout isn't supported yet: use a terminal.",
  // The forge (GitHub through `gh`).
  forge_auth: "Sign in to GitHub: run `gh auth login`, then retry.",
  forge_cli: "The GitHub CLI failed: install `gh` and run `gh auth login`, then retry.",
  forge_not_found:
    "GitHub couldn't find the pull request: check its number and your access to the repository.",
  forge_forbidden:
    "GitHub denied access: check your permissions on the repository, or run `gh auth login`.",
  forge_rate_limit: "GitHub's rate limit was reached: wait a few minutes, then retry.",
  forge_unsupported: "This forge isn't supported yet: open the pull request on its website.",
  forge_conflict:
    "GitHub refused: the PR changed, has conflicts or failing checks. Refresh, then retry.",
  forge_invalid_data: "GitHub's reply couldn't be read: update `gh`, then refresh.",
  forge_limit: "The pull request is too large to read here: open it on GitHub.",
  forge_cancelled: "The GitHub request was cancelled: try again.",
  // Review mode.
  review_not_found: "The daemon no longer has this review: comment again to start a new one.",
  not_found: "The daemon no longer has this review: comment again to start a new one.",
  not_actionable: "The comment is resolved or its lines are gone: reopen it or comment again.",
  review_comment_unavailable:
    "The comment is resolved or its lines are gone: reopen it or comment again.",
  review_reviewer_unavailable:
    "AI review isn't available on this daemon yet: comment and send the comments to the agent.",
  review_executor_unavailable:
    "The agent is unavailable on this daemon: start the daemon with its engine, then retry.",
  review_queue_rejected:
    "The agent couldn't take the comments: check the thread's queue and provider, then retry.",
  review_target_mismatch: "The thread's checkout moved: review its current changes instead.",
  review_target_unavailable: "The thread's checkout is moving: wait for it to settle, then retry.",
  review_suggestion_conflict:
    "The lines changed since the suggestion: check it against the new code first.",
  review_suggestion_unavailable:
    "This suggestion can't be applied: it is resolved, outdated or on removed lines.",
  review_workspace_not_found: "The thread's project is gone: open the project again.",
  review_limit: "This review is full: resolve or discard some comments first.",
  unsupported_by_fake_daemon: "This daemon can't do that yet: update the daemon.",
};

/** The sentence for a refusal code; the general one for a code without its own. */
export function actionErrorText(code: string | undefined): string {
  return (code && copy[code]) || "The daemon couldn't do that: try again, or check its logs.";
}
