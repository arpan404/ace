import type { ForgeCapability } from "@ace/protocol/forge-capabilities";
import type { ForgeKind } from "@ace/protocol/forge";

/*
 * What each host's adapter supports (ADR 0117): the one table the daemon reports to clients.
 * An adapter adds a capability here in the same change that implements and tests it, never
 * before. GitHub's integration predates this table and supports everything; GitLab supports
 * everything but stacks, suggestions, reactions and media.
 */

const github: readonly ForgeCapability[] = [
  "reviews.read",
  "reviews.files",
  "reviews.commits",
  "reviews.comments.read",
  "reviews.comments.write",
  "reviews.approvals.read",
  "reviews.approvals.write",
  "reviews.checks",
  "reviews.checks.write",
  "reviews.create",
  "reviews.edit",
  "reviews.merge",
  "reviews.autoMerge",
  "reviews.stacks",
  "reviews.suggestions",
  "issues.read",
  "issues.write",
  "inbox",
  "reactions",
  "media",
];

/** Gitea and Forgejo share one adapter through tea: reads, comments, approvals, commit-status
 * checks, pinned merge and issues. */
const tea: readonly ForgeCapability[] = [
  "reviews.read",
  "reviews.files",
  "reviews.commits",
  "reviews.comments.read",
  "reviews.comments.write",
  "reviews.approvals.read",
  "reviews.approvals.write",
  "reviews.checks",
  "reviews.merge",
  "issues.read",
  "issues.write",
];

export const forgeCapabilities: Readonly<Record<ForgeKind, readonly ForgeCapability[]>> = {
  github,
  gitlab: [
    "reviews.read",
    "reviews.files",
    "reviews.commits",
    "reviews.comments.read",
    "reviews.comments.write",
    "reviews.approvals.read",
    "reviews.approvals.write",
    "reviews.checks",
    "reviews.checks.write",
    "reviews.create",
    "reviews.edit",
    "reviews.merge",
    "reviews.autoMerge",
    "issues.read",
    "issues.write",
    "inbox",
  ],
  origin: ["reviews.read", "reviews.files"],
  gitbucket: [],
  bitbucket: [],
  gitea: tea,
  forgejo: tea,
};

export function supports(forge: ForgeKind, capability: ForgeCapability): boolean {
  return forgeCapabilities[forge].includes(capability);
}
