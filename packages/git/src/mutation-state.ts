import type { MutationLease } from "@ace/provider-kit/cleanup";
import { within } from "./repository-paths.ts";

export interface MutationState {
  status: "available" | "quarantined";
  leases: readonly MutationLease[];
}

/** Who holds a lease: this process (running or quarantined), or the probed owner's answer. */
export type LeaseOwnerState = "running" | "held" | "active" | "quarantined" | "unknown" | "gone";
/** See `rootKind` in lease-roots.ts. */
export type RootKind = "gone" | "unregistered" | "linked" | "other";

export interface LeaseFacts {
  record: MutationLease;
  owner: LeaseOwnerState;
  /** One kind per entry of `record.roots`. */
  roots: readonly RootKind[];
}

/** A root that no longer is a checkout of this repository can't be touched by its mutation. */
const settledRoot = (kind: RootKind) => kind === "gone" || kind === "unregistered";

/**
 * Retired without asking: its owner definitively stopped and nothing it mutated is still a
 * checkout of this repository. A crashed worktree add or remove whose worktree is gone is one.
 */
export function retiresAutomatically(facts: LeaseFacts): boolean {
  return facts.owner === "gone" && facts.roots.every(settledRoot);
}

/**
 * Retired when a person confirms it ("Clear stale lock"): its owner definitively stopped.
 * The person vouches that nothing the stopped daemon started is still writing.
 */
export function retiresOnConfirmation(facts: LeaseFacts): boolean {
  return facts.owner === "gone";
}

/** Only a mutation on a main checkout or a separate repository reaches shared state. */
export function repositoryWide(facts: LeaseFacts): boolean {
  return facts.roots.some((kind) => kind === "other");
}

/**
 * Whether a lease fences `path`. This process's running leases never do: its scheduling locks
 * already serialize them. A healthy foreign owner fences only the roots it overlaps. Anything
 * uncertain fences the roots it overlaps, and the whole repository when it is repository-wide.
 */
export function fences(facts: LeaseFacts, path: string): boolean {
  if (facts.owner === "running") return false;
  const overlaps = facts.record.roots.some((root) => within(root, path) || within(path, root));
  if (facts.owner === "active") return overlaps;
  return overlaps || repositoryWide(facts);
}

export function leaseState(facts: readonly LeaseFacts[], path: string): MutationState {
  const leases = facts.filter((entry) => fences(entry, path)).map(({ record }) => record);
  return { status: leases.length ? "quarantined" : "available", leases };
}

/** Plain words for the first fencing lease: which repository, which checkout, and why. */
export function quarantineMessage(
  facts: LeaseFacts,
  repository: string,
  since: Date | undefined,
): string {
  const started = since
    ? ` (started ${since.toISOString().slice(0, 16).replace("T", " ")} UTC)`
    : "";
  const where = `a Git operation in ${facts.record.root}${started}`;
  const blocked = `Git changes in ${repository} are blocked`;
  switch (facts.owner) {
    case "active":
      return `Another ace daemon is running ${where}. ${blocked} until it finishes.`;
    case "gone":
      return `${blocked}: ${where} was interrupted when the ace daemon running it stopped. If nothing is still writing there, use Clear stale lock.`;
    case "unknown":
      return `${blocked}: ${where} belongs to an ace daemon that isn't answering. Wait for it, or stop it and then use Clear stale lock.`;
    default:
      return `${blocked}: ${where} was stopped, but a process it started may still be writing. Restart the ace daemon, then use Clear stale lock.`;
  }
}
