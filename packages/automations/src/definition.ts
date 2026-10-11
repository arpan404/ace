import { migratePermissionMode } from "@ace/provider-kit/permission-modes";
import { Automation } from "@ace/protocol";

/** Canonicalize accepted compatibility selectors before comparison, execution and storage. */
export function normalizeAutomation(input: unknown): Automation {
  const automation = Automation.parse(input);
  const permissionMode =
    automation.provider === "acp" || automation.provider === "antigravity"
      ? automation.permissionMode
      : migratePermissionMode(automation.provider, automation.permissionMode);
  return { ...automation, permissionMode: permissionMode ?? undefined };
}
