import { accessRank, stricterOffer } from "@ace/provider-kit/access-modes";
import { AccessMode, type AccessModeOffer, type PermissionPolicyIdentity } from "@ace/protocol";

/**
 * A thread's stored access: one of the four ace modes, `custom:<native>` for an Advanced
 * native override, or null for a provider that offers no ace mode (its own default).
 */
export type AccessSelection = string;
type Policy = PermissionPolicyIdentity & { mode: AccessSelection | null };

export const customSelection = (native: string): AccessSelection => `custom:${native}`;
export function customNative(selection: AccessSelection | null): string | undefined {
  return selection?.startsWith("custom:") ? selection.slice(7) : undefined;
}

/** The ace mode rank (ADR 0075): 0 Read-only … 3 Full access; undefined for Custom/default. */
function rank(selection: AccessSelection | null): number | undefined {
  const mode = AccessMode.safeParse(selection);
  return mode.success ? accessRank(mode.data) : undefined;
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

/**
 * A child is within its parent's ceiling when it can do no more: a mode ranked at or below the
 * parent's, on any provider, or exactly the parent's own unranked policy on the same identity.
 */
export function permissionWithinCeiling(parent: Policy, child: Policy): boolean {
  // Full access is unrestricted: any child, even an agent's unranked default, does no more.
  if (parent.mode === "full-access") return true;
  const ceiling = rank(parent.mode);
  const requested = rank(child.mode);
  if (ceiling !== undefined && requested !== undefined) return requested <= ceiling;
  return sameIdentity(parent, child) && parent.mode === child.mode;
}

/** The modes a child's instance offers that an explicit request may choose under `parent`. */
export function allowedChildModes(
  parent: Policy,
  offers: readonly AccessModeOffer[],
): AccessMode[] {
  const ceiling = rank(parent.mode);
  return ceiling === undefined
    ? []
    : offers.filter((offer) => accessRank(offer.mode) <= ceiling).map((offer) => offer.mode);
}

/**
 * The mode a child takes when it inherits: the broadest mode its instance offers at or below
 * the parent's, or the parent's own unranked policy on the same identity. Undefined when no
 * offered mode is that strict.
 */
export function inheritedPermissionMode(
  parent: Policy,
  child: PermissionPolicyIdentity,
  offers: readonly AccessModeOffer[],
): AccessSelection | null | undefined {
  const mode = AccessMode.safeParse(parent.mode);
  if (mode.success)
    return (
      stricterOffer(mode.data, offers)?.mode ??
      (mode.data === "full-access" && !offers.length ? null : undefined)
    );
  return sameIdentity(parent, child) ? parent.mode : undefined;
}

/**
 * The mode a thread's children are measured against while a change is pending: the stricter
 * of the acknowledged and requested modes. An unreported side is unknown, so the reported one
 * stands.
 */
export function ceilingMode(
  effective: AccessSelection | null,
  requested: AccessSelection | null,
): AccessSelection | null {
  if (effective === requested || requested === null) return effective;
  if (effective === null) return requested;
  const current = rank(effective);
  const next = rank(requested);
  return current !== undefined && next !== undefined && next < current ? requested : effective;
}
