import type { ProviderKind } from "@ace/protocol";
import type { Engine } from "../engine/index.ts";
import type { ProviderStatuses } from "../provider-status.ts";

/**
 * What delegation admission reads about a provider, made current first. Delegations start
 * with nobody watching (automations, other machines' calls), so nothing else may have checked
 * since a CLI was installed or a login changed outside ace. A status check older than five
 * minutes runs again (its ACP logins included), and a provider with no adapter is discovered,
 * as a command for it would be. Work is proportional to delegations, with no polling.
 */
export function providerFacts(
  statuses: Pick<ProviderStatuses, "fresh"> | undefined,
  engine: Pick<Engine, "ensureProvider">,
): (provider: ProviderKind) => Promise<void> {
  return async (provider) => {
    await statuses?.fresh();
    await engine.ensureProvider(provider);
  };
}
