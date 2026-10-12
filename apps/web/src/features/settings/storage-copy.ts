import type { StorageKind, StorageReason } from "@ace/protocol";

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
export function storageBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
