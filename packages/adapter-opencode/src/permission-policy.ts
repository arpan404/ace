import { z } from "zod";
import type { PermissionMode } from "@ace/protocol";

/** Native agents own their permissions; never replace configured rules on a session. */
export function opencodePermissionAgent(mode: PermissionMode): "build" | "plan" {
  return z.enum(["build", "plan"]).parse(mode);
}
