import { CodexPermissionOptions } from "@ace/provider-kit/permission-modes";
import type { ThreadStartParams } from "./generated/v2/ThreadStartParams.ts";
import type { TurnStartParams } from "./generated/v2/TurnStartParams.ts";
import type { PermissionMode } from "@ace/protocol";

/** An ace mode's selector names profile, approval policy and reviewer; a custom profile only itself. */
export function codexThreadPolicy(
  mode: PermissionMode | null,
  _cwd: string,
): Pick<ThreadStartParams, "permissions" | "approvalPolicy" | "approvalsReviewer" | "config"> {
  if (mode === null) return {};
  if (!mode.startsWith("{")) return { permissions: mode };
  const { approvalPolicy, ...options } = CodexPermissionOptions.parse(JSON.parse(mode));
  return { ...options, ...(approvalPolicy ? { approvalPolicy } : {}) };
}
export function codexTurnPolicy(
  mode: PermissionMode | null,
  cwd: string,
): Pick<TurnStartParams, "permissions" | "approvalPolicy" | "approvalsReviewer"> {
  return codexThreadPolicy(mode, cwd);
}
