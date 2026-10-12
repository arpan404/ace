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
}

const forceable = new Set<StorageReason>(["uncommitted", "unpushed"]);
/** Pure eligibility. A force authorizes only this worktree's dirty/unpublished contents. */
export function planStorageItem(
  candidate: StorageCandidate,
  retention: StorageRetention,
  now: number,
  forceItems: ReadonlySet<string>,
): StorageItem {
  const forced = candidate.kind === "worktrees" && forceItems.has(candidate.id);
  const protections = candidate.protections.filter((reason) => !(forced && forceable.has(reason)));
  const days = retention[candidate.kind];
  if (days === null) protections.push("retention_disabled");
  else if (candidate.modifiedAt > now - days * 86400000) protections.push("within_retention");
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
