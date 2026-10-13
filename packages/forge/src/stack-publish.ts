import type {
  ForgeLocalStack,
  ForgeStack,
  ForgeStackExpected,
  ForgeStackOperation,
} from "@ace/protocol/forge-stacks";
import { matchesStackBranches, sameStack } from "./stack-plan.ts";

/** One layer to publish: move `branch` from the revision reviewed before rebase to `target`. */
export type StackPublishUpdate = { number: number; branch: string; lease: string; target: string };
export type StackPublishPlan =
  | { ok: true; updates: StackPublishUpdate[] }
  | { ok: false; reason: "membership" | "moved" | "unrestacked" | "unchanged" };
/** Git's per-ref report for an atomic leased push. */
export type StackPublishReport = {
  exitCode: number;
  refs: readonly {
    ref: string;
    status: "updated" | "up_to_date" | "rejected";
    reason: string | null;
  }[];
};
export type StackPublisher = (request: {
  remote: string;
  updates: readonly { ref: string; lease: string; target: string }[];
  signal: AbortSignal;
  beforeDispatch(): void;
}) => Promise<StackPublishReport>;

/** A rebased stack can be published, or an unconfirmed publication repeated under its leases. */
export function canPublishAfter(operation: ForgeStackOperation): boolean {
  return (
    operation.state === "push_partial" ||
    (operation.action === "push" && operation.state === "uncertain")
  );
}

/** Active local layers whose head differs from the host revision reviewed before rebase. */
export function stackPublishUpdates(reviewed: ForgeStackExpected): StackPublishUpdate[] {
  const leases = new Map(reviewed.layers.map((layer) => [layer.number, layer.headSha]));
  const updates: StackPublishUpdate[] = [];
  for (const branch of reviewed.local?.branches ?? []) {
    const lease = branch.pr && leases.get(branch.pr.number);
    if (branch.isMerged || !branch.pr || !lease || lease === branch.head) continue;
    updates.push({ number: branch.pr.number, branch: branch.name, lease, target: branch.head });
  }
  return updates;
}

/** Each active layer must sit on the layer below it before any of them is published. */
export function isRestacked(local: ForgeLocalStack): boolean {
  const active = local.branches.filter((branch) => !branch.isMerged);
  return active.every(
    (branch, index) =>
      !branch.needsRebase && (index === 0 || branch.base === active[index - 1]?.head),
  );
}

/**
 * `reviewed` carries the host revisions recorded when the rebase was confirmed and the
 * local stack confirmed for publication. The host must still hold the reviewed revisions;
 * every lease is one of them, so a later collaborator commit can never be overwritten.
 */
export function planStackPublication(
  reviewed: ForgeStackExpected,
  local: ForgeLocalStack,
  stack: ForgeStack,
): StackPublishPlan {
  if (!matchesStackBranches(local, stack)) return { ok: false, reason: "membership" };
  if (!sameStack(reviewed, stack)) return { ok: false, reason: "moved" };
  if (!isRestacked(local)) return { ok: false, reason: "unrestacked" };
  const updates = stackPublishUpdates({ ...reviewed, local });
  return updates.length ? { ok: true, updates } : { ok: false, reason: "unchanged" };
}

/** Atomic pushes either apply every ref or none; anything else needs a host read. */
export function stackPublishResult(
  updates: readonly StackPublishUpdate[],
  report: StackPublishReport,
): "published" | "refused" | "unknown" {
  const refs = new Map(report.refs.map((ref) => [ref.ref, ref]));
  const planned = updates.map((update) => refs.get(`refs/heads/${update.branch}`));
  if (report.exitCode === 0 && planned.every((ref) => ref && ref.status !== "rejected"))
    return "published";
  if (report.exitCode !== 0 && planned.some((ref) => ref?.status === "rejected")) return "refused";
  return "unknown";
}

/** Compare GitHub's current layer heads with a recorded publication's leases and targets. */
export function reconcileStackPublication(
  updates: readonly StackPublishUpdate[],
  stack: ForgeStack,
): "published" | "unpublished" | "unknown" {
  if (!updates.length) return "unknown";
  const heads = updates.map(
    (update) => stack.layers.find((layer) => layer.number === update.number)?.headSha,
  );
  if (updates.every((update, index) => heads[index] === update.target)) return "published";
  if (updates.every((update, index) => heads[index] === update.lease)) return "unpublished";
  return "unknown";
}

/** Continuing or publishing a rebase keeps the host revisions reviewed when it started. */
export function sameReviewedRevisions(a: ForgeStackExpected, b: ForgeStackExpected): boolean {
  return (
    a.id === b.id &&
    a.trunk === b.trunk &&
    a.layers.length === b.layers.length &&
    a.layers.every(
      (layer, index) =>
        layer.number === b.layers[index]?.number && layer.headSha === b.layers[index]?.headSha,
    )
  );
}
