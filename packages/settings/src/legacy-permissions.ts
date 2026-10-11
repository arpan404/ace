import { migratePermissionMode } from "@ace/provider-kit/permission-modes";
import { SettingsValues, ProviderKind, type PermissionMode } from "@ace/protocol";

/** Only explicit persisted legacy values participate in migration. */
export function legacyPermissionMode(value: unknown): PermissionMode {
  const policy = SettingsValues.shape["approvals.policy"].parse(value);
  return policy === "never" ? "full-access" : policy === "ask" ? "ask" : "auto-review";
}

/** Provider maps written by the preset UI also need migration, without inventing defaults. */
export function migrateProviderPermissions(value: Record<string, string>): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, id] of Object.entries(value)) {
    const provider = ProviderKind.safeParse(key);
    const native = provider.success ? migratePermissionMode(provider.data, id) : id;
    if (native !== null) next[key] = native;
  }
  return next;
}
