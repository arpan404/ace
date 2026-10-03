import type { Account } from "@ace/conductor";
import type { ConductorSpec, ProviderKind } from "@ace/protocol";

/** All candidates must be usable; busy capacity remains a scheduler concern. */
export function startRejection(
  spec: ConductorSpec,
  facts: {
    workspaceExists: boolean;
    installed: ReadonlySet<ProviderKind>;
    accounts: readonly Account[];
  },
): string | undefined {
  if (!facts.workspaceExists) return "conductor_workspace_not_found";
  for (const model of Object.values(spec.policies.roles).flat()) {
    if (!facts.installed.has(model.provider)) return "conductor_provider_unavailable";
    if (!facts.accounts.some((account) => account.provider === model.provider && account.quota > 0))
      return "conductor_account_unavailable";
  }
  return undefined;
}
