import { antigravityIdentity } from "@ace/accounts/acp-instances";
import type { AccountSummary, ManagedAccountProvider } from "@ace/protocol/accounts";

/**
 * Antigravity's accounts, as the daemon keeps them: ACP accounts of its own installation, the
 * CLI login and those added in their own homes. Every other provider's are its own.
 */
export function ofManagedProvider(row: AccountSummary, provider: ManagedAccountProvider): boolean {
  return provider === "antigravity"
    ? row.provider === "acp" &&
        row.acpAgentId === antigravityIdentity.acpAgentId &&
        row.installationId === antigravityIdentity.installationId
    : row.provider === provider;
}

/** What an account added to a provider's page is: an Antigravity one is a managed ACP account. */
export function addedAccountIdentity(
  provider: ManagedAccountProvider,
  id: string,
): Pick<
  AccountSummary,
  "provider" | "acpAgentId" | "installationId" | "instanceId" | "homeStrategy"
> {
  return provider === "antigravity"
    ? {
        provider: "acp",
        acpAgentId: antigravityIdentity.acpAgentId,
        installationId: antigravityIdentity.installationId,
        instanceId: id,
        homeStrategy: "managed",
      }
    : { provider };
}
