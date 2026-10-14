import type { PublicToolCode } from "@ace/mcp-server";

/** Authored failures retain diagnostic detail while their public messages stay fixed. */
export class AgentControlError extends Error {
  readonly code: PublicToolCode;
  /** ace-authored words the calling agent may read, e.g. which modes it can retry with. */
  readonly publicDetail: string | undefined;
  constructor(code: PublicToolCode, detail: string, cause?: unknown, publicDetail?: string) {
    super(detail, cause === undefined ? undefined : { cause });
    this.code = code;
    this.publicDetail = publicDetail;
  }
}

const quoted = (modes: readonly string[]) => modes.map((mode) => `"${mode}"`).join(", ");
/**
 * A refused child access in words the agent can act on: why, the parent's mode and the modes
 * the target would accept (ADR 0075).
 */
export function ceilingRefusal(
  child: import("@ace/protocol").ProviderKind,
  refusal: import("../engine/permissions.ts").CeilingRefusal | undefined,
): AgentControlError {
  const parent =
    refusal?.mode == null || refusal.mode.startsWith("custom:")
      ? "The parent thread runs a provider-native mode ace can't rank, so a child must match it."
      : `The parent thread runs in "${refusal.mode}".`;
  if (refusal?.reason === "access_unavailable")
    return new AgentControlError(
      "access_unavailable",
      "access_unavailable",
      undefined,
      `${child} supports ${quoted(refusal.offered)}. Allowed under the parent: ${quoted(refusal.allowed) || "none"}.`,
    );
  const allowed = refusal?.allowed.length
    ? `Allowed ${child} access: ${quoted(refusal.allowed)}.`
    : `No ${child} mode fits under it; delegate to ${refusal?.provider ?? "the parent's provider"} or ask the person to change the parent's mode.`;
  return new AgentControlError(
    refusal?.reason === "access_escalation_denied"
      ? "access_escalation_denied"
      : "delegation_denied",
    refusal?.reason ?? "permission_ceiling_unverifiable",
    undefined,
    `${parent} ${allowed}`,
  );
}

/** Only trusted engine admission results enter this mapping, never provider error objects. */
export function controlAdmissionError(reason: string): AgentControlError {
  const codes: Record<string, PublicToolCode> = {
    provider_unavailable: "provider_unavailable",
    provider_disabled: "provider_disabled",
    model_unavailable: "model_unavailable",
    account_unavailable: "account_unavailable",
    cancelled: "delegation_cancelled",
    daemon_shutting_down: "admission_closed",
    engine_starting: "admission_closed",
    engine_capacity_exceeded: "delegation_limit",
    workspace_not_found: "workspace_unavailable",
    workspace_unavailable: "workspace_unavailable",
    workspace_change_in_progress: "workspace_unavailable",
    launch_options_unsupported: "not_supported",
    permission_mode_unsupported: "not_supported",
    permission_exceeds_parent: "delegation_denied",
    permission_ceiling_unverifiable: "delegation_denied",
    access_escalation_denied: "access_escalation_denied",
    access_unavailable: "access_unavailable",
    access_mode_unavailable: "access_unavailable",
  };
  return new AgentControlError(codes[reason] ?? "execution_failed", reason);
}
