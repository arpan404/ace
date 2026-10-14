import type { Capabilities, PermissionMode } from "@ace/protocol";

/** Whether an instance accepts a native selector: one of its ace modes or its native vocabulary. */
export function supportsPermissionMode(
  capabilities: Pick<Capabilities, "accessModes" | "permissions"> | undefined,
  mode: PermissionMode | null,
): boolean {
  if (mode === null) return true;
  if (capabilities?.accessModes?.some((offer) => offer.native === mode)) return true;
  const choices = capabilities?.permissions?.permissionModes;
  // ACP advertises session modes after opening, Codex can use configured named profiles.
  if (!choices?.length) return true;
  return choices.some((choice) => choice.id === mode);
}
