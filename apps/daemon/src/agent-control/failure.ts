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

/**
 * A refused child policy in words the agent can act on: the parent's mode and the child
 * modes it would accept. Mode IDs are provider vocabulary from ace's own tables.
 */
export function ceilingRefusal(
  child: import("@ace/protocol").ProviderKind,
  refusal: { provider: string; mode: string | null; allowed: readonly string[] } | undefined,
): AgentControlError {
  const parent = refusal
    ? `The parent thread runs ${refusal.provider} in ${refusal.mode === null ? "its provider default" : `"${refusal.mode}"`}.`
    : "The parent thread's permission policy can't be verified.";
  const allowed = refusal?.allowed.length
    ? `Allowed ${child} modes: ${refusal.allowed.map((mode) => `"${mode}"`).join(", ")}.`
    : `No ${child} mode fits under it; delegate to ${refusal?.provider ?? "the parent's provider"} or ask the person to change the parent's mode.`;
  return new AgentControlError(
    "delegation_denied",
    "permission_ceiling_unverifiable",
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
  };
  return new AgentControlError(codes[reason] ?? "execution_failed", reason);
}
