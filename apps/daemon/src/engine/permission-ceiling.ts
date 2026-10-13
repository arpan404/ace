import { cursorMode, nativePermissionModes } from "@ace/provider-kit/permission-modes";
import type { PermissionMode, PermissionPolicyIdentity } from "@ace/protocol";

type Policy = PermissionPolicyIdentity & { mode: PermissionMode | null };
function sameIdentity(parent: PermissionPolicyIdentity, child: PermissionPolicyIdentity) {
  return (
    parent.provider === child.provider &&
    parent.backend === child.backend &&
    parent.acpAgentId === child.acpAgentId &&
    parent.installationId === child.installationId &&
    parent.instanceId === child.instanceId
  );
}

/** Native display risk is not an ordering. Only known containment is accepted. */
export function permissionWithinCeiling(parent: Policy, child: Policy): boolean {
  const unrestricted =
    parent.backend !== "acp" &&
    ((parent.provider === "codex" && parent.mode === ":danger-full-access") ||
      (parent.provider === "claude" && parent.mode === "bypassPermissions") ||
      (parent.provider === "cursor" && parent.mode === cursorMode(false, false)) ||
      // ADR 0050: Pi has no native sandbox or permission mode. Its process has
      // the user's OS rights; an ace MCP call still needs separate ace consent.
      (parent.provider === "pi" && parent.mode === null));
  if (unrestricted) return true;
  // The same execution identity at the same mode is the same authority, even when
  // that mode is the provider's unreported default.
  if (sameIdentity(parent, child) && parent.mode === child.mode) return true;
  if (parent.mode === null || child.mode === null) return false;
  // These pairs retain the same provider's isolation/configuration while reducing autonomy.
  if (
    parent.provider !== child.provider ||
    parent.backend !== child.backend ||
    parent.provider === "acp"
  )
    return false;
  if (
    nativePermissionModes(parent.provider).some((mode) => mode.id === parent.mode) &&
    parent.mode === child.mode
  )
    return true;
  if (parent.provider === "codex")
    return (
      nativePermissionModes("codex").some((mode) => mode.id === parent.mode) &&
      child.mode === ":read-only"
    );
  if (parent.provider === "claude")
    return ["default", "acceptEdits", "auto"].includes(parent.mode) && child.mode === "plan";
  if (parent.provider === "opencode") return parent.mode === "build" && child.mode === "plan";
  if (parent.provider === "cursor")
    return parent.mode === cursorMode(true, true) && child.mode === cursorMode(true, false);
  return false;
}

export function inheritedPermissionMode(
  parent: Policy,
  child: PermissionPolicyIdentity,
): PermissionMode | null {
  if (
    parent.provider === child.provider &&
    permissionWithinCeiling(parent, { ...child, mode: parent.mode })
  )
    return parent.mode;
  const provider = child.provider;
  const candidate =
    provider === "claude"
      ? "default"
      : provider === "codex"
        ? ":workspace"
        : provider === "opencode"
          ? "plan"
          : provider === "cursor"
            ? cursorMode(true, false)
            : null;
  return permissionWithinCeiling(parent, { ...child, mode: candidate }) ? candidate : null;
}
