import type { AcpIdentity, RegistryApproval, RegistryPendingUpdate } from "@ace/protocol";
import { matchProfile } from "./profiles.ts";

/*
 * Approving an agent's update in place (ADR 0044 amendment, agents that update themselves).
 * An approved executable that changed on disk never runs until the person approves exactly the
 * files they were shown, for the same installation identity, so its threads keep their ids and
 * resumes. Pure: the inventory hashes, this decides.
 */

/** How many approvals an installation keeps, oldest dropped first. */
const keptApprovals = 16;

/** The approved facts an update is judged against (a `LocalInstallation`'s). */
export interface Approved {
  metadata: AcpIdentity & {
    version: string;
    profileRevision: string;
    approvals?: RegistryApproval[] | undefined;
  };
  executableDigest: string;
  bridgeDigest?: string | undefined;
}

/** What is on disk now. */
export interface Observed {
  executableDigest: string;
  bridgeDigest?: string | undefined;
}

/** The short name of an agent for a sentence: its catalog name, else its id without a prefix. */
export function agentLabel(acpAgentId: string): string {
  return acpAgentId.replace(/^(official|local):/, "");
}

/**
 * A launch refused because the approved files changed. The message names the agent and the
 * action that lets it run again; nothing an agent does can take that action (ADR 0044).
 */
export class UpdateApprovalRequired extends Error {
  readonly identity: AcpIdentity;
  constructor(identity: AcpIdentity, name: string = agentLabel(identity.acpAgentId)) {
    super(
      `${name} changed since you approved it, so ace won't run it. Approve the update in Settings → Providers to keep using it.`,
    );
    this.name = "UpdateApprovalRequired";
    this.identity = identity;
  }
}

/** The pending update `observed` makes of `entry`, or undefined when nothing changed. */
export function pendingUpdate(
  entry: Approved,
  observed: Observed,
  observedAt: number,
): RegistryPendingUpdate | undefined {
  const changed: RegistryPendingUpdate["changed"] = [];
  if (observed.executableDigest !== entry.executableDigest) changed.push("agent");
  if (entry.bridgeDigest !== undefined && observed.bridgeDigest !== entry.bridgeDigest)
    changed.push("native_cli");
  if (!changed.length) return undefined;
  const { acpAgentId, installationId, instanceId } = entry.metadata;
  return {
    acpAgentId,
    installationId,
    instanceId,
    changed,
    executableDigest: observed.executableDigest,
    ...(observed.bridgeDigest !== undefined ? { bridgeDigest: observed.bridgeDigest } : {}),
    observedAt,
  };
}

/** What the person approves: the digests they were shown, and the version if their client knows. */
export interface UpdateApproval extends Observed {
  version?: string | undefined;
}

/**
 * `entry` approved for what is on disk now. Refused unless the approval names exactly the files
 * on disk (`observed`) and they differ from what was approved, so a file that changed again after
 * the person looked isn't approved unseen, and an approval can't be replayed.
 */
export function approveUpdate<T extends Approved>(
  entry: T,
  approval: UpdateApproval,
  observed: Observed,
  approvedAt: number,
): T {
  if (
    approval.executableDigest !== observed.executableDigest ||
    approval.bridgeDigest !== observed.bridgeDigest
  )
    throw new Error("The agent changed again; review the update again");
  if (!pendingUpdate(entry, observed, approvedAt))
    throw new Error("Nothing changed since approval");
  const { metadata } = entry;
  const version = approval.version ?? metadata.version;
  const record: RegistryApproval = {
    approvedAt,
    previousVersion: metadata.version,
    version,
    previousExecutableDigest: entry.executableDigest,
    executableDigest: observed.executableDigest,
    ...(entry.bridgeDigest !== undefined ? { previousBridgeDigest: entry.bridgeDigest } : {}),
    ...(observed.bridgeDigest !== undefined ? { bridgeDigest: observed.bridgeDigest } : {}),
  };
  const profile = metadata.acpAgentId.startsWith("official:")
    ? matchProfile(metadata.acpAgentId.slice(9), version)
    : undefined;
  return {
    ...entry,
    metadata: {
      ...metadata,
      version,
      profileRevision: profile?.revision ?? "generic-v1",
      approvals: [...(metadata.approvals ?? []), record].slice(-keptApprovals),
    },
    executableDigest: observed.executableDigest,
    ...(observed.bridgeDigest !== undefined ? { bridgeDigest: observed.bridgeDigest } : {}),
  };
}
