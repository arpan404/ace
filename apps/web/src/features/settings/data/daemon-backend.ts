import type { ClientApi } from "@ace/client";
import type { AccountView, ProviderStatus } from "@ace/ui-core";
import { readProviderStatuses } from "@/lib/provider-statuses.ts";
import type { AccessSource } from "./access-source.ts";
import type { ProviderAccount, ProviderInstall, SettingsBackend } from "./backend.ts";
import { daemonValues } from "./daemon-values.ts";

function login(account: AccountView): ProviderAccount {
  return {
    id: account.id,
    label: account.label,
    plan: "",
    auth: account.quota.auth,
    availability: account.availability,
  };
}

/** A provider as Settings lists it: what discovery found, with its ace accounts. */
function providerInstall(status: ProviderStatus): ProviderInstall {
  return {
    kind: status.provider,
    acpAgentId: status.acpAgentId,
    name: status.name,
    binary: status.binary,
    state: status.state,
    ...(status.actionId ? { actionId: status.actionId } : {}),
    version: status.version,
    ...(status.provider === "acp" ? { via: "via ACP" } : {}),
    accounts: status.accounts.map(login),
  };
}

/**
 * Settings against the connected daemon: values through `settings.subscribe` / `settings.set`,
 * providers from discovery and `accounts.list` (`readProviderStatuses`), and paired devices, machines and ACP agents added by command
 * through `access`.
 */
export function daemonSettingsBackend(
  client: ClientApi,
  options: { access: AccessSource; defaults: Readonly<Record<string, unknown>> },
): SettingsBackend {
  const { access, defaults } = options;
  const values = daemonValues(client, Object.keys(defaults));
  const providers = async () => {
    const statuses = await readProviderStatuses(client);
    // Agents added by command aren't discovered yet: nothing on the daemon runs them so far.
    const added = (await access.acpAgents()).map((agent): ProviderInstall => ({
      kind: "acp",
      name: agent.name,
      binary: agent.binary,
      state: "not_installed",
      version: undefined,
      via: "via ACP",
      added: true,
      accounts: [],
    }));
    return [...statuses.map(providerInstall), ...added];
  };
  return {
    values,
    set: (key, value) => values.set(key, value),
    // The protocol has no unset; write back what each page shows when nothing is stored.
    reset: async () => {
      for (const [key, value] of Object.entries(defaults)) await values.set(key, value);
    },
    providers,
    async rediscover() {
      const reply = await client.request({ type: "providers.request", operation: "refresh" });
      if (!reply.result.ok) throw new Error("Provider discovery unavailable");
      return providers();
    },
    canAddAcpAgent: access.canAddAcpAgent,
    addAcpAgent: (agent) => access.addAcpAgent(agent),
    removeAcpAgent: (name) => access.removeAcpAgent(name),
    machines: () => access.machines(),
    remoteStatus: () => access.remoteStatus(),
    devices: () => access.devices(),
    pair: (scopes) => access.pair(scopes),
    revoke: (deviceId) => access.revoke(deviceId),
  };
}
