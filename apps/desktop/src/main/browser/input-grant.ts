import type { BrowserControllerLease } from "@ace/protocol";

/**
 * A renderer of this app says the person holds a thread's page through its own daemon
 * connection, `owner` (the id its take-control reply named). `since` is the lease generation
 * the desktop had when the claim arrived.
 */
export interface RendererClaim {
  owner: string;
  since: number;
}

/** The claim lets the person's input through: the lease is human and its owner's. */
export function claimHolds(claim: RendererClaim | undefined, lease: BrowserControllerLease) {
  return claim !== undefined && lease.controller === "human" && lease.owner === claim.owner;
}

/**
 * The claim after the daemon sends a new lease. A lease that is the claim's owner's keeps it;
 * any newer lease that isn't (a handback, another device taking control, the agent) revokes
 * it for good, so a stale claim can never let input through later. A lease no newer than the
 * claim leaves it pending: the renderer may claim before its lease reaches the desktop.
 */
export function claimAfterLease(
  claim: RendererClaim | undefined,
  lease: BrowserControllerLease,
): RendererClaim | undefined {
  if (!claim) return undefined;
  if (claimHolds(claim, lease)) return claim;
  return lease.generation > claim.since ? undefined : claim;
}
