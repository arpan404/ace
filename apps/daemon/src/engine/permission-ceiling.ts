import { codexReviewerMode, cursorMode } from "@ace/provider-kit/permission-modes";
import type { PermissionMode, PermissionPolicyIdentity, ProviderKind } from "@ace/protocol";

type Policy = PermissionPolicyIdentity & { mode: PermissionMode | null };

/**
 * What a native mode lets an agent do without a person, for delegation containment only
 * (ADR 0069, delegation ceiling): 0 reads and plans, 1 acts only on approval or prior grants,
 * 2 edits the workspace without asking, 3 lets an automatic reviewer approve, 4 is unrestricted.
 * Only the provider-defined modes listed here have a capability; opaque ACP selectors, custom
 * profiles and unreported defaults have none and are contained only by an identical policy.
 * Within a capability, the first listed mode is the one an inherited child takes.
 * `inheritable: false` marks modes an instance may not offer (classifier or reviewer availability),
 * so inheritance never picks them; an explicit request still can.
 */
const capabilities: Partial<
  Record<ProviderKind, readonly { mode: PermissionMode; level: number; inheritable?: false }[]>
> = {
  claude: [
    { mode: "plan", level: 0 },
    { mode: "default", level: 1 },
    { mode: "dontAsk", level: 1 },
    { mode: "acceptEdits", level: 2 },
    { mode: "auto", level: 3, inheritable: false },
    { mode: "bypassPermissions", level: 4 },
  ],
  codex: [
    { mode: ":read-only", level: 0 },
    { mode: ":workspace", level: 2 },
    { mode: codexReviewerMode("auto_review"), level: 3, inheritable: false },
    { mode: codexReviewerMode("guardian_subagent"), level: 3, inheritable: false },
    { mode: ":danger-full-access", level: 4 },
  ],
  opencode: [
    { mode: "plan", level: 0 },
    { mode: "build", level: 2 },
  ],
  cursor: [
    { mode: cursorMode(true, false), level: 2 },
    { mode: cursorMode(true, true), level: 3 },
    { mode: cursorMode(false, false), level: 4 },
    { mode: cursorMode(false, true), level: 4 },
  ],
};

function capability(policy: Policy): number | undefined {
  if (policy.backend === "acp" || policy.mode === null) return undefined;
  return capabilities[policy.provider]?.find((entry) => entry.mode === policy.mode)?.level;
}

function sameIdentity(parent: PermissionPolicyIdentity, child: PermissionPolicyIdentity) {
  return (
    parent.provider === child.provider &&
    parent.backend === child.backend &&
    parent.acpAgentId === child.acpAgentId &&
    parent.installationId === child.installationId &&
    parent.instanceId === child.instanceId
  );
}

function unrestricted(parent: Policy): boolean {
  if (parent.backend === "acp") return false;
  // ADR 0050: Pi has no native sandbox or permission mode. Its process has
  // the user's OS rights; an ace MCP call still needs separate ace consent.
  if (parent.provider === "pi") return parent.mode === null;
  return capability(parent) === 4;
}

/**
 * A child is within its parent's ceiling when it can do no more than the parent: the same
 * policy, or a mode with known capability at or below the parent's, on any provider.
 */
export function permissionWithinCeiling(parent: Policy, child: Policy): boolean {
  if (unrestricted(parent)) return true;
  // The same execution identity at the same mode is the same authority, even when
  // that mode is the provider's unreported default or an opaque ACP selector.
  if (sameIdentity(parent, child) && parent.mode === child.mode) return true;
  const ceiling = capability(parent);
  const requested = capability(child);
  return ceiling !== undefined && requested !== undefined && requested <= ceiling;
}

/** The modes of `child`'s provider an explicit request may choose under `parent`, most capable last. */
export function allowedChildModes(
  parent: Policy,
  child: PermissionPolicyIdentity,
): PermissionMode[] {
  return (capabilities[child.provider] ?? [])
    .filter((entry) => permissionWithinCeiling(parent, { ...child, mode: entry.mode }))
    .map((entry) => entry.mode);
}

/**
 * The mode a child takes when it names none: its parent's own mode on the same identity,
 * otherwise the most capable inheritable mode of its provider within the parent's ceiling,
 * among the modes the child's instance `offered`, when known.
 */
export function inheritedPermissionMode(
  parent: Policy,
  child: PermissionPolicyIdentity,
  offered?: readonly PermissionMode[],
): PermissionMode | null {
  if (
    parent.provider === child.provider &&
    permissionWithinCeiling(parent, { ...child, mode: parent.mode })
  )
    return parent.mode;
  const candidates = (capabilities[child.provider] ?? [])
    .filter((entry) => entry.inheritable !== false)
    .filter((entry) => !offered || offered.includes(entry.mode))
    .filter((entry) => permissionWithinCeiling(parent, { ...child, mode: entry.mode }));
  let best: (typeof candidates)[number] | undefined;
  for (const entry of candidates) if (!best || entry.level > best.level) best = entry;
  return best?.mode ?? null;
}

/**
 * The mode a thread's children are measured against while a change is pending: the stricter
 * of the acknowledged and requested modes. An unreported side is unknown, so the reported
 * one stands: a requested mode before the first acknowledgement, the last acknowledged mode
 * after a reset to the provider default.
 */
export function ceilingMode(
  identity: PermissionPolicyIdentity,
  effective: PermissionMode | null,
  requested: PermissionMode | null,
): PermissionMode | null {
  if (effective === requested || requested === null) return effective;
  if (effective === null) return requested;
  const current = capability({ ...identity, mode: effective });
  const next = capability({ ...identity, mode: requested });
  return current !== undefined && next !== undefined && next < current ? requested : effective;
}
