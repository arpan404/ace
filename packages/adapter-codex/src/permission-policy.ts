import type { ThreadStartParams } from "./generated/v2/ThreadStartParams.ts";
import type { TurnStartParams } from "./generated/v2/TurnStartParams.ts";
import type { PermissionMode } from "@ace/protocol";
export function codexThreadPolicy(
  mode: PermissionMode,
  cwd: string,
): Pick<ThreadStartParams, "approvalPolicy" | "sandbox" | "approvalsReviewer" | "config"> {
  return {
    approvalPolicy: mode === "full-access" ? "never" : "on-request",
    sandbox:
      mode === "full-access"
        ? "danger-full-access"
        : mode === "read-only"
          ? "read-only"
          : "workspace-write",
    approvalsReviewer: "user",
    ...(mode === "full-access"
      ? {}
      : {
          config: {
            "sandbox_workspace_write.writable_roots": [cwd],
            "sandbox_workspace_write.network_access": false,
            "sandbox_workspace_write.exclude_tmpdir_env_var": true,
            "sandbox_workspace_write.exclude_slash_tmp": true,
          },
        }),
  };
}
export function codexTurnPolicy(
  mode: PermissionMode,
  cwd: string,
): Pick<TurnStartParams, "approvalPolicy" | "sandboxPolicy" | "approvalsReviewer"> {
  return {
    approvalPolicy: mode === "full-access" ? "never" : "on-request",
    approvalsReviewer: "user",
    sandboxPolicy:
      mode === "full-access"
        ? { type: "dangerFullAccess" }
        : mode === "read-only"
          ? { type: "readOnly", networkAccess: false }
          : {
              type: "workspaceWrite",
              writableRoots: [cwd],
              networkAccess: false,
              excludeTmpdirEnvVar: true,
              excludeSlashTmp: true,
            },
  };
}
