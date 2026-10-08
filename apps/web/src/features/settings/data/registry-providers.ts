import { latestInstallation } from "@ace/ui-core/acp-registry";
import { providerDisplayName } from "@ace/ui-core";
import type { ClientApi } from "@ace/client";
import { readRegistry, type RegistryView } from "../acp-registry/registry-data.ts";
import type { ProviderInstall } from "./backend.ts";

/**
 * Providers with what the ACP registry installed: an agent its accounts already name gains its
 * registry facts (version, entry, for Update); one nothing names yet joins as an ACP agent, so
 * an install shows up in Providers at once. Local command bindings aren't registry installs.
 */
export async function withRegistryInstalls(
  client: ClientApi,
  installs: readonly ProviderInstall[],
): Promise<ProviderInstall[]> {
  // A daemon without the registry service (or a device that can't read it) lists none.
  const registry = await readRegistry(client).catch(() => undefined);
  return registryProviders(installs, registry);
}

function registryProviders(
  installs: readonly ProviderInstall[],
  registry: Pick<RegistryView, "agents" | "installations"> | undefined,
): ProviderInstall[] {
  if (!registry) return [...installs];
  const ids = [
    ...new Set(
      registry.installations
        .filter((entry) => entry.acpAgentId !== "official:antigravity-acp")
        .filter((entry) => !entry.acpAgentId.startsWith("local:"))
        .map((entry) => entry.acpAgentId),
    ),
  ];
  const facts = ids.flatMap((id) => {
    const installed = latestInstallation(id, registry.installations);
    if (!installed) return [];
    const agent = registry.agents.find((entry) => entry.acpAgentId === id);
    return [{ id, name: agent?.name ?? providerDisplayName("acp", id), installed, agent }];
  });
  const matched = new Set<string>();
  const merged = installs.map((install) => {
    if (install.kind !== "acp") return install;
    const fact = facts.find(
      (entry) => entry.id === install.acpAgentId || entry.name === install.name,
    );
    if (!fact) return install;
    matched.add(fact.id);
    return {
      ...install,
      name: fact.name,
      acpAgentId: install.acpAgentId ?? fact.id,
      instance:
        install.accounts.find((account) => account.id === fact.installed.instanceId)?.id ??
        install.accounts[0]?.id ??
        fact.installed.instanceId,
      registry: { version: fact.installed.version, agent: fact.agent },
    };
  });
  const joined = facts
    .filter((fact) => !matched.has(fact.id))
    .map((fact): ProviderInstall => ({
      kind: "acp",
      acpAgentId: fact.id,
      instance: fact.installed.instanceId,
      name: fact.name,
      binary: fact.name,
      state: "unknown",
      version: fact.installed.version,
      via: "via ACP",
      accounts: [],
      registry: { version: fact.installed.version, agent: fact.agent },
    }));
  return [...merged, ...joined];
}
