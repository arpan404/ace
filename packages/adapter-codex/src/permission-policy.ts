import { CodexPermissionOptions } from "@ace/provider-kit/permission-modes";
import type { ThreadStartParams } from "./generated/v2/ThreadStartParams.ts";
import type { TurnStartParams } from "./generated/v2/TurnStartParams.ts";
import type { PermissionMode } from "@ace/protocol";
export function codexThreadPolicy(
  mode: PermissionMode | null,
  _cwd: string,
): Pick<ThreadStartParams, "permissions" | "approvalsReviewer" | "config"> {
  if (mode === null) return {};
  return mode.startsWith("{")
    ? CodexPermissionOptions.parse(JSON.parse(mode))
    : { permissions: mode };
}
export function codexTurnPolicy(
  mode: PermissionMode | null,
  cwd: string,
): Pick<TurnStartParams, "permissions" | "approvalsReviewer"> {
  return codexThreadPolicy(mode, cwd);
}
