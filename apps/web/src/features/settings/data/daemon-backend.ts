import type { ClientApi } from "@ace/client";
import type { CatalogModel, ProviderKind } from "@ace/protocol";
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
    auth: account.signedIn ? "logged_in" : "logged_out",
    availability: account.signedIn ? account.availability : "logged_out",
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
    version: status.version,
    ...(status.provider === "acp" ? { via: "via ACP" } : {}),
    accounts: status.accounts.map(login),
  };
}

/** One row per model, however many accounts serve it. */
function distinct(models: readonly CatalogModel[]): CatalogModel[] {
  const seen = new Set<string>();
  return models.filter((model) => {
    const key = `${model.provider}\u0000${model.nativeModelId}`;
    if (model.hidden || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Settings against the connected daemon: values through `settings.subscribe` / `settings.set`,
 * providers from discovery and `accounts.list` (`readProviderStatuses`), models from
 * `models.list` / `models.refresh`, and paired devices, machines and ACP agents added by command
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
  const models = async (provider: ProviderKind) => {
    const reply = await client.request({
      type: "models.list",
      options: { provider, offset: 0, limit: 100 },
    });
    return "models" in reply.result ? distinct(reply.result.models) : [];
  };
  return {
    values,
    set: (key, value) => values.set(key, value),
    // The protocol has no unset; write back what each page shows when nothing is stored.
    reset: async () => {
      for (const [key, value] of Object.entries(defaults)) await values.set(key, value);
    },
    providers,
    rediscover: providers,
    canAddAcpAgent: access.canAddAcpAgent,
    addAcpAgent: (agent) => access.addAcpAgent(agent),
    removeAcpAgent: (name) => access.removeAcpAgent(name),
    models,
    async refreshModels(provider) {
      await client.request({ type: "models.refresh", filter: { provider } });
      return models(provider);
    },
    machines: () => access.machines(),
    devices: () => access.devices(),
    pair: (scopes) => access.pair(scopes),
    revoke: (deviceId) => access.revoke(deviceId),
  };
}
