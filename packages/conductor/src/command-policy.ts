import { z } from "zod";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { ConductorSpec, type ProviderKind } from "@ace/protocol";

export const Key = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
/** Execution intents require a native root identity; the wire stays additive. */
export const StartSpec = ConductorSpec.refine(
  (spec) => z.uuid().safeParse(spec.rootAgentId).success,
  { path: ["rootAgentId"], message: "Native conductor root must be a UUID" },
);

/** Wire identities can contain punctuation; journal receipts have a bounded Key contract. */
export function conductorReceipt(device: string, command: string): string {
  return `cmd.${bytesToHex(sha256(new TextEncoder().encode(JSON.stringify([device, command]))))}`;
}

const refusals = new Set([
  "gate_not_pending",
  "plan_missing",
  "merge_not_ready",
  "budget_must_increase",
  "deadline_must_be_future",
  "lane_not_live",
  "run_retention_limit",
  "run_not_found",
  "input_backpressure",
  "control_backpressure",
  "actor_backpressure",
  "effect_backpressure",
  "conductor_invalid_spec",
  "conductor_invalid_root_agent",
  "conductor_workspace_not_found",
  "conductor_workspace_not_git",
  "conductor_provider_unavailable",
  "conductor_account_unavailable",
]);

/** Only public refusal codes cross the command boundary. Never forward arbitrary error text. */
export function conductorCommandError(error: unknown): string {
  return error instanceof Error && refusals.has(error.message)
    ? error.message
    : "conductor_command_failed";
}

/** All candidates must be usable; busy capacity remains a scheduler concern. */
export function conductorStartRejection(
  spec: ConductorSpec,
  facts: {
    workspaceExists: boolean;
    workspaceGit: boolean;
    installed: ReadonlySet<ProviderKind>;
    accounts: readonly { provider: ProviderKind; quota: number }[];
  },
): string | undefined {
  if (!facts.workspaceExists) return "conductor_workspace_not_found";
  if (!facts.workspaceGit) return "conductor_workspace_not_git";
  for (const model of Object.values(spec.policies.roles).flat()) {
    if (!facts.installed.has(model.provider)) return "conductor_provider_unavailable";
    if (!facts.accounts.some((account) => account.provider === model.provider && account.quota > 0))
      return "conductor_account_unavailable";
  }
  return undefined;
}
