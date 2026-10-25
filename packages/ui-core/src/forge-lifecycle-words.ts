import type {
  ForgeLifecycleAction,
  ForgeLockReason,
  ForgeMergeCommit,
  ForgeMergeState,
  ForgePrDetail,
} from "@ace/protocol";
import type { MergeMethod } from "./pull-request.ts";

/*
 * What a pull request's lifecycle writes are called wherever they show, and the merge commit
 * GitHub would write. Pure.
 */

/** What each lifecycle write is called wherever it shows: menu rows, result strips, toasts. */
export const lifecycleLabels: Record<ForgeLifecycleAction["kind"], string> = {
  edit: "Edit pull request",
  ready: "Ready for review",
  draft: "Convert to draft",
  close: "Close pull request",
  reopen: "Reopen pull request",
  "update.merge": "Update branch",
  "update.rebase": "Update with rebase",
  revert: "Revert changes",
  lock: "Lock conversation",
  unlock: "Unlock conversation",
  "branch.delete": "Delete branch",
  "branch.restore": "Restore branch",
  "issue.link": "Link the issue",
  "issue.unlink": "Unlink the issue",
};

/** GitHub's lock reasons, as the page says them. */
export const lockReasonLabels: Record<ForgeLockReason, string> = {
  off_topic: "Off-topic",
  too_heated: "Too heated",
  resolved: "Resolved",
  spam: "Spam",
};

/**
 * The commit a merge or squash writes, as GitHub would prefill it: its own text for this account
 * when it says, else its defaults (a merge names the PR and branch; a squash is the PR's title
 * with its number and the description below).
 */
export function defaultMergeCommit(
  detail: ForgePrDetail,
  method: Exclude<MergeMethod, "rebase">,
  state: ForgeMergeState | undefined,
): ForgeMergeCommit {
  const own = state?.commitMessages?.[method];
  if (own) return own;
  const { status } = detail;
  const owner = detail.headRepository?.owner ?? status.ref.repository.owner;
  return method === "merge"
    ? {
        title: `Merge pull request #${status.ref.number} from ${owner}/${detail.headBranch}`,
        message: status.title,
      }
    : { title: `${status.title} (#${status.ref.number})`, message: detail.body };
}
