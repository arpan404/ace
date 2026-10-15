import { join } from "node:path";
import type { ProviderHome } from "./contracts.ts";

export function inventoryRoots(instance: ProviderHome): string[] {
  return instance.provider === "claude"
    ? [join(instance.homeDir, "projects")]
    : instance.provider === "pi"
      ? [join(instance.homeDir, "sessions")]
      : instance.provider === "codex"
        ? [join(instance.homeDir, "sessions"), join(instance.homeDir, "archived_sessions")]
        : [join(instance.homeDir, "storage/session")];
}
