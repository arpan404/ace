import { cursorMode, nativePermissionModes } from "@ace/provider-kit/permission-modes";
import type { PermissionMode, ProviderKind } from "@ace/protocol";

/** Native display risk is not an ordering. Only known containment is accepted. */
export function permissionWithinCeiling(
  parent: { provider: ProviderKind; mode: PermissionMode | null },
  child: { provider: ProviderKind; mode: PermissionMode | null },
): boolean {
  if (parent.mode === null || child.mode === null) return false;
  if (parent.provider === child.provider && parent.mode === child.mode) return true;
  const unrestricted =
    (parent.provider === "codex" && parent.mode === ":danger-full-access") ||
    (parent.provider === "claude" && parent.mode === "bypassPermissions") ||
    (parent.provider === "cursor" && parent.mode === cursorMode(false, false));
  if (unrestricted)
    return nativePermissionModes(child.provider).some((mode) => mode.id === child.mode);
  // These pairs retain the same provider's isolation/configuration while reducing autonomy.
  if (parent.provider !== child.provider) return false;
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
  parent: { provider: ProviderKind; mode: PermissionMode | null },
  provider: ProviderKind,
): PermissionMode | null {
  if (parent.provider === provider) return parent.mode;
  const candidate =
    provider === "claude"
      ? "default"
      : provider === "codex"
        ? ":read-only"
        : provider === "opencode"
          ? "plan"
          : provider === "cursor"
            ? cursorMode(true, false)
            : null;
  return permissionWithinCeiling(parent, { provider, mode: candidate }) ? candidate : null;
}
