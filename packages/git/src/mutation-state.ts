import type { MutationLease } from "@ace/provider-kit/cleanup";
import { within } from "./repository-paths.ts";

export interface MutationState {
  status: "available" | "quarantined";
  leases: readonly MutationLease[];
}

/**
 * Who holds a lease: this process (`running`, or `held` once quarantined), this process without
 * any record of it (`orphaned`: written by this daemon, then forgotten), or the probed owner.
 */
export type LeaseOwnerState =
  | "running"
  | "held"
  | "orphaned"
  | "active"
  | "quarantined"
  | "unknown"
  | "gone";
/** See `rootKind` in lease-roots.ts. */
export type RootKind = "gone" | "unregistered" | "linked" | "other";

export interface LeaseFacts {
  record: MutationLease;
  owner: LeaseOwnerState;
  /** One kind per entry of `record.roots`. */
  roots: readonly RootKind[];
  /**
   * The live processes that may still be doing this lease's work, named for a person. Empty:
   * proven finished (its killed process groups are gone, or no Git process runs in its roots).
   * `undefined`: no such evidence exists, as when a cleanup supervisor owns the proof.
   */
  busy?: readonly string[] | undefined;
}

/** A root that no longer is a checkout of this repository can't be touched by its mutation. */
const settledRoot = (kind: RootKind) => kind === "gone" || kind === "unregistered";
/** Owners that can't finish the lease themselves: stopped, forgotten, or ours and quarantined. */
const abandoned = (owner: LeaseOwnerState) =>
  owner === "gone" || owner === "orphaned" || owner === "held";

/**
 * Retired without asking: nothing can still be doing its work. Either its owner definitively
 * stopped and nothing it mutated is still a checkout of this repository, or its owner can't
 * finish it and no process that could be running its work is still alive.
 */
export function retiresAutomatically(facts: LeaseFacts): boolean {
  if (facts.owner === "gone" && facts.roots.every(settledRoot)) return true;
  return abandoned(facts.owner) && facts.busy?.length === 0;
}

/**
 * Retired when a person confirms it ("Clear stale lock"): its owner definitively stopped or
 * forgot it, and no live process is known to still do its work. The person vouches for writers
 * ace can't see.
 */
export function retiresOnConfirmation(facts: LeaseFacts): boolean {
  return (facts.owner === "gone" || facts.owner === "orphaned") && !facts.busy?.length;
}

/**
 * Worth waiting for: a live owner will finish it, or a live process holds it and the lease
 * retires on its own once that process ends.
 */
export function clearsOnItsOwn(facts: LeaseFacts): boolean {
  if (facts.owner === "active" || facts.owner === "quarantined") return true;
  return abandoned(facts.owner) && (facts.busy?.length ?? 0) > 0;
}

/** Only a mutation on a main checkout or a separate repository reaches shared state. */
export function repositoryWide(facts: LeaseFacts): boolean {
  return facts.roots.some((kind) => kind === "other");
}

/**
 * A linked worktree has its own index and HEAD: a mutation there reaches only that checkout and
 * the paths inside it, never the checkout its directory happens to sit in. Anything else
 * overlaps by path.
 */
function overlaps(root: string, kind: RootKind | undefined, path: string): boolean {
  if (kind === "linked") return within(root, path);
  return within(root, path) || within(path, root);
}

/**
 * Whether a lease fences `path`. This process's running leases never do: its scheduling locks
 * already serialize them. A healthy foreign owner fences only the roots it overlaps. Anything
 * uncertain fences the roots it overlaps, and the whole repository when it is repository-wide.
 */
export function fences(facts: LeaseFacts, path: string): boolean {
  if (facts.owner === "running") return false;
  const touched = facts.record.roots.some((root, index) =>
    overlaps(root, facts.roots[index], path),
  );
  if (facts.owner === "active") return touched;
  return touched || repositoryWide(facts);
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
  if (facts.busy?.length)
    return `${blocked}: ${where} is still held by ${facts.busy.join(", ")}. ace continues on its own once that ends.`;
  switch (facts.owner) {
    case "active":
      return `Another ace daemon is running ${where}. ${blocked} until it finishes.`;
    case "gone":
      return `${blocked}: ${where} was interrupted when the ace daemon running it stopped. If nothing is still writing there, use Clear stale lock.`;
    case "orphaned":
      return `${blocked}: ${where} was stopped and ace can't confirm its processes ended. If nothing is still writing there, use Clear stale lock.`;
    case "unknown":
      return `${blocked}: ${where} belongs to an ace daemon that isn't answering. Wait for it, or stop it and then use Clear stale lock.`;
    default:
      return `${blocked}: ${where} was stopped, but a process it started may still be writing. Restart the ace daemon, then use Clear stale lock.`;
  }
}
