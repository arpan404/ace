import type { StorageItem, StorageKind, StorageReason, StorageRetention } from "@ace/protocol";

/** Facts are collected by the owning stores, never accepted from a client. */
export interface StorageCandidate {
  id: string;
  kind: StorageKind;
  label: string;
  bytes: number;
  modifiedAt: number;
  threadIds: string[];
  fingerprint: string;
  protections: StorageReason[];
  eligibleReason: StorageReason;
  branch?: string | null;
  removeBranch?: boolean;
  settledAt?: number;
  mergedIntoMain?: boolean;
  /** A worktree owner is neither archived nor deleted, even if settled. */
  openThreads?: boolean;
}

const forceable = new Set<StorageReason>(["uncommitted", "unpushed"]);
/**
 * Archive state only. Automatic retention (`idleThreads`) removes idle threads whether or not
 * they were archived; every liveness protection (working, waiting, queued, pinned) still holds.
 */
const archival = new Set<StorageReason>(["not_archived", "live_thread"]);
/** Pure eligibility. A force authorizes only this worktree's dirty/unpublished contents. */
export function planStorageItem(
  candidate: StorageCandidate,
  retention: StorageRetention,
  now: number,
  forceItems: ReadonlySet<string>,
): StorageItem {
  const forced = candidate.kind === "worktrees" && forceItems.has(candidate.id);
  const protections = candidate.protections.filter(
    (reason) =>
      !(forced && forceable.has(reason)) &&
      !(retention.idleThreads && candidate.kind === "threads" && archival.has(reason)),
  );
  const settled =
    candidate.kind === "worktrees" &&
    (retention.worktreeMode === "settled" || retention.worktreeMode === "all_settled");
  // Archived mode keeps worktrees of open threads, settled or not.
  if (candidate.kind === "worktrees" && !settled && candidate.openThreads)
    protections.push("live_thread");
  if (settled) {
    if (candidate.settledAt === undefined) protections.push("not_settled");
    if (retention.worktreeMode === "settled" && !candidate.mergedIntoMain)
      protections.push("not_merged");
  }
  const days = retention[candidate.kind];
  if (!(settled && retention.worktreeMode === "all_settled")) {
    if (days === null) protections.push("retention_disabled");
    else if (
      (settled ? (candidate.settledAt ?? now) : candidate.modifiedAt) >
      now - days * 86400000
    )
      protections.push("within_retention");
  }
  return {
    id: candidate.id,
    kind: candidate.kind,
    label: candidate.label,
    bytes: candidate.bytes,
    modifiedAt: candidate.modifiedAt,
    threadIds: candidate.threadIds,
    disposition: protections.length ? "protect" : "remove",
    reasons: protections.length ? [...new Set(protections)] : [candidate.eligibleReason],
    forced,
    effects:
      candidate.kind === "threads"
        ? ["transcript_payloads", "attachment_references", "browser_data"]
        : candidate.kind === "worktrees"
          ? candidate.removeBranch
            ? ["worktree", "local_branch"]
            : ["worktree"]
          : ["file"],
    ...(candidate.branch !== undefined ? { branch: candidate.branch } : {}),
    ...(candidate.removeBranch !== undefined ? { removeBranch: candidate.removeBranch } : {}),
  };
}
