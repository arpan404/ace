import type { StorageKind, StorageReason } from "@ace/protocol";
import { pluralCount } from "./counts.ts";

export const storageLabels: Record<StorageKind, string> = {
  threads: "Threads and transcripts",
  attachments: "Attachments",
  artifacts: "Browser artifacts and recordings",
  logs: "Logs and support bundles",
  worktrees: "Worktrees",
  caches: "Caches",
};
export const storageReasons: Record<StorageReason, string> = {
  retention_disabled: "Cleanup disabled",
  within_retention: "Still within retention",
  archived_thread: "Old archived thread",
  not_archived: "Thread is not archived",
  not_settled: "Thread is not settled",
  not_merged: "Branch has changes outside origin/main",
  pinned: "Pinned thread",
  active_tree: "Thread or task tree still has work",
  pending_input: "Queued, held or unacknowledged input",
  live_thread: "Belongs to a retained thread",
  referenced: "Attachment is referenced",
  leased: "Currently in use",
  unowned: "No remaining references",
  expired: "Past retention",
  task_finished: "Task finished",
  pr_merged: "Pull requests merged",
  pr_closed: "Pull requests closed",
  orphaned: "No owning thread",
  missing_directory: "Worktree directory is missing",
  main_worktree: "Main checkout",
  locked_worktree: "Worktree is locked",
  uncommitted: "Uncommitted or ignored files",
  unpushed: "Commits are not known to be pushed",
  unknown_git_state: "Git state could not be verified",
  unsafe_path: "Path is unsafe",
  changed: "Changed since preview",
  already_removed: "Already removed",
  cleanup_in_progress: "Another operation owns cleanup",
  owner_unavailable: "Ownership could not be verified",
};

/** "1 item", "4,583 items". */
export const itemCount = (count: number) => pluralCount(count, "item");

/*
 * Why a worktree backup failed, by the code the daemon recorded, with what to do next. The
 * worktree is always kept, so the next step is backing it up yourself. Plain text: no markdown.
 */
const backupFailures: Record<string, string> = {
  output_too_large: "It has too many files to back up automatically: commit and push it yourself.",
  invalid_argument: "It has no topic branch with an origin to push to: push it yourself.",
  auth_failed: "Git couldn't sign in to origin: check your SSH key or run gh auth login.",
  remote_unreachable: "Git couldn't reach origin: check your connection.",
  push_rejected: "Origin has commits this branch doesn't: pull them, then push it yourself.",
  push_lease_stale: "Origin's branch moved during the backup: pull it, then push it yourself.",
  protected_branch: "Origin protects this branch: push it to a new branch yourself.",
  head_moved: "The branch moved during the backup: it's backed up next time.",
  hook_failed: "A Git hook refused the commit or push: fix what it reports, then push it yourself.",
  identity_missing: "Git doesn't know who you are: set user.name and user.email.",
  sensitive_publication:
    "Its changes look like they hold a secret, so nothing was pushed: check them, then push it yourself.",
  publication_scan_incomplete:
    "Its changes couldn't be checked for secrets, so nothing was pushed: push it yourself.",
  git_timeout: "Git took too long: commit and push it yourself.",
};

/** A failed backup's reason in words; codes without their own sentence get a general one. */
export function backupFailureText(code: string | undefined): string {
  return (
    (code !== undefined && backupFailures[code]) ||
    "The backup didn't finish: commit and push it yourself."
  );
}

export interface FailedBackupsView {
  /** "Backup failed for 2 worktrees. They were kept." */
  line: string;
  /** The first few, each with its reason. */
  entries: { path: string; reason: string }[];
  /** "and 3 more", when some aren't listed. */
  more: string | null;
}

/** Failed backups as one note, so a bad origin can't flood the page. */
export function failedBackupsView(
  backups: readonly { path: string; state: "complete" | "failed"; error?: string | undefined }[],
): FailedBackupsView | null {
  const failed = backups.filter((backup) => backup.state === "failed");
  if (!failed.length) return null;
  const shown = failed.slice(0, 3);
  return {
    line:
      failed.length === 1
        ? "Backup failed for 1 worktree. It was kept."
        : `Backup failed for ${failed.length} worktrees. They were kept.`,
    entries: shown.map((backup) => ({
      path: backup.path,
      reason: backupFailureText(backup.error),
    })),
    more: failed.length > shown.length ? `and ${failed.length - shown.length} more` : null,
  };
}
