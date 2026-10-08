import type { PermissionMode, PermissionCapabilities } from "@ace/protocol";
export function supportsPermissionMode(
  capabilities: PermissionCapabilities | undefined,
  mode: PermissionMode | null,
): boolean {
  if (mode === null) return true;
  const choices = capabilities?.permissionModes;
  // ACP advertises session modes after opening, Codex can use configured named profiles.
  if (!choices?.length) return true;
  return choices.some((choice) => choice.id === mode);
}
