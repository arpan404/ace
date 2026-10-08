import { z } from "zod";
import type { PermissionMode } from "@ace/protocol";
export function opencodePermissionRules(
  mode: PermissionMode,
): { action: string; resource: string; effect: "allow" | "ask" | "deny" }[] {
  return [{ action: "*", resource: "*", effect: z.enum(["allow", "ask", "deny"]).parse(mode) }];
}
