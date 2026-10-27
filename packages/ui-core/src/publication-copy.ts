/** Stable daemon error codes never surface raw CLI stderr or credential-bearing URLs. */
export function publicationProblem(code: string): string {
  if (code === "publication_sensitive_history")
    return "Publication blocked: tracked files or Git history reachable from HEAD contain sensitive paths or credential patterns, including history already on the remote. Deleting a file or adding it to .gitignore does not remove earlier commits. Rotate any exposed credentials, then use your own Git tools to remove sensitive files and content from every reachable commit, or prepare a clean repository. Review the cleaned history and Resume publication. ace never rewrites history.";
  if (code === "publication_scan_incomplete")
    return "Publication blocked because the complete history could not be scanned within safety limits. Fetch complete history if this is a shallow or partial clone; inspect oversized objects and Git LFS content, then prepare a smaller, fully inspectable history with your own Git tools. ace never rewrites history.";
  if (code === "forge_outcome_uncertain")
    return "Creation may have completed, but its outcome could not be confirmed under the intended identity. The dispatched attempt and any known repository receipt are preserved. Restore the intended Source control identity, check GitHub, then Resume publication to reconcile before adding origin or pushing. ace will not repeat an unconfirmed creation.";
  if (code === "forge_preferences_changed")
    return "Source control settings changed during publication. Rescan this computer, confirm the intended host and account, then Resume publication.";
  if (code === "publication_git_transport_failed")
    return "The repository was created, but Git could not push. Check this computer's Git credential helper, SSH keys and repository push permission, then Resume publication. GitHub API sign-in alone does not grant Git access.";
  if (code === "publication_not_repository")
    return "This folder is not a Git repository. Initialize it with your own Git CLI, then Refresh status and publish.";
  if (code === "publication_origin_exists")
    return "This project already has an origin. Publish only projects without an origin; ace won't replace it.";
  if (code === "publication_name_taken")
    return "That repository name already exists. Choose another name before publishing.";
  if (code === "publication_cancelled")
    return "Publication stopped. Any created repository is preserved. Resume publication to reconcile its state.";
  if (code === "publication_creation_uncertain")
    return "Creation was sent, but no matching repository can be confirmed. Check GitHub and your selected account, then Resume publication. ace will only look up this exact repository; it won't create it again.";
  if (code === "publication_remote_changed" || code === "publication_remote_mismatch")
    return "The hosted repository no longer matches this publication. Check its owner, name and identity on GitHub. ace stopped before pushing.";
  if (code === "forge_forbidden" || code === "publication_account_changed")
    return "GitHub API access was refused or the CLI account changed. Check Source control settings and organization access, sign in with your own gh CLI, then Rescan and Resume publication.";
  if (code === "publication_requires_repo_root")
    return "Publish the repository root rather than a folder inside it.";
  if (code === "publication_busy" || code === "project_busy")
    return "Publication is already running. Refresh publication status before retrying.";
  return "Publication couldn't finish. Refresh status to see any created repository, check GitHub CLI readiness and network, then Resume publication.";
}
