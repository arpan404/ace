import type { PermissionMode } from "@ace/protocol";
export function opencodePermissionRules(
  mode: PermissionMode,
): { action: string; resource: string; effect: "allow" | "ask" }[] {
  return [{ action: "*", resource: "*", effect: mode === "full-access" ? "allow" : "ask" }];
}
