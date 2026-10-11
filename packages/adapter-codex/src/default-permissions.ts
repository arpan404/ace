import { z } from "zod";
import type { TurnStartParams } from "./generated/v2/TurnStartParams.ts";

const Approval = z.union([
  z.enum(["untrusted", "on-request", "never"]),
  z.object({
    granular: z.object({
      sandbox_approval: z.boolean(),
      rules: z.boolean(),
      skill_approval: z.boolean(),
      request_permissions: z.boolean(),
      mcp_elicitations: z.boolean(),
    }),
  }),
]);
const Config = z.object({
  config: z.object({
    default_permissions: z.string().min(1).max(256).nullish(),
    sandbox_mode: z.enum(["read-only", "workspace-write", "danger-full-access"]).nullish(),
    approval_policy: Approval.nullish(),
    approvals_reviewer: z.enum(["user", "auto_review", "guardian_subagent"]).nullish(),
  }),
});

/** An omitted turn override preserves sticky native settings, so it cannot reset them. */
export function configuredTurnPolicy(
  value: unknown,
): Pick<TurnStartParams, "permissions" | "approvalPolicy" | "approvalsReviewer"> {
  const { config } = Config.parse(value);
  const permissions =
    config.default_permissions ??
    (config.sandbox_mode
      ? {
          "read-only": ":read-only",
          "workspace-write": ":workspace",
          "danger-full-access": ":danger-full-access",
        }[config.sandbox_mode]
      : undefined);
  if (!permissions || !config.approval_policy)
    throw new Error(
      "Codex did not report its configured permission default. The previous native permission remains applied; choose an explicit mode before continuing.",
    );
  return {
    permissions,
    approvalPolicy: config.approval_policy,
    approvalsReviewer: config.approvals_reviewer ?? "user",
  };
}
