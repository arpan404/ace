import type { PublicToolCode } from "@ace/mcp-server";

/** Authored failures retain diagnostic detail while their public messages stay fixed. */
export class AgentControlError extends Error {
  readonly code: PublicToolCode;
  constructor(code: PublicToolCode, detail: string, cause?: unknown) {
    super(detail, cause === undefined ? undefined : { cause });
    this.code = code;
  }
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
  };
  return new AgentControlError(codes[reason] ?? "execution_failed", reason);
}
