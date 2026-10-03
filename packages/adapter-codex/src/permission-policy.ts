import type { ThreadStartParams } from "./generated/v2/ThreadStartParams.ts";
import type { TurnStartParams } from "./generated/v2/TurnStartParams.ts";
/** Engine callers require full access; read-only is the safe legacy default. */
export function codexThreadPolicy(
  mode: "full-access" | "read-only",
): Pick<ThreadStartParams, "approvalPolicy" | "sandbox" | "approvalsReviewer"> {
  return {
    approvalPolicy: mode === "full-access" ? "never" : "on-request",
    sandbox: mode === "full-access" ? "danger-full-access" : "read-only",
    approvalsReviewer: "user",
  };
}
export function codexTurnPolicy(
  mode: "full-access" | "read-only",
): Pick<TurnStartParams, "approvalPolicy" | "sandboxPolicy" | "approvalsReviewer"> {
  return {
    approvalPolicy: mode === "full-access" ? "never" : "on-request",
    approvalsReviewer: "user",
    sandboxPolicy:
      mode === "full-access"
        ? { type: "dangerFullAccess" }
        : { type: "readOnly", networkAccess: false },
  };
}
