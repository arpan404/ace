import { SettingsValues, type PermissionMode } from "@ace/protocol";

/** Only explicit persisted legacy values participate in migration. */
export function legacyPermissionMode(value: unknown): PermissionMode {
  const policy = SettingsValues.shape["approvals.policy"].parse(value);
  return policy === "never" ? "full-access" : policy === "ask" ? "ask" : "auto-review";
}
