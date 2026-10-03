import type { ClientApi } from "@ace/client";
import type { CatalogModel, ProviderKind } from "@ace/protocol";
import { accountView, providerNames, type AccountView } from "@ace/ui-core";
import type { AccessSource } from "./access-source.ts";
import type { ProviderAccount, ProviderInstall, SettingsBackend } from "./backend.ts";
import { daemonValues } from "./daemon-values.ts";

/** Native CLIs discovery looks for, in the order Settings lists them, with their executables. */
const natives: readonly { kind: Exclude<ProviderKind, "acp">; binary: string }[] = [
  { kind: "claude", binary: "claude" },
  { kind: "codex", binary: "codex" },
  { kind: "opencode", binary: "opencode" },
  { kind: "cursor", binary: "cursor-agent" },
  { kind: "antigravity", binary: "antigravity" },
];

function login(account: AccountView): ProviderAccount {
  return {
    id: account.id,
    label: account.label,
    plan: "",
    auth: account.signedIn ? "logged_in" : "logged_out",
    availability: account.signedIn ? account.availability : "logged_out",
  };
}

/**
 * Providers as Settings lists them, from `accounts.list`: every native CLI (an installed one has
 * at least one account instance), then each ACP agent with its instances.
 */
export function providerInstalls(accounts: readonly AccountView[]): ProviderInstall[] {
  const native = natives.map(({ kind, binary }): ProviderInstall => {
    const own = accounts.filter((account) => account.provider === kind);
    return {
      kind,
      name: providerNames[kind],
      binary,
      version: own.length ? (own.find((a) => a.version)?.version ?? "") : null,
      accounts: own.map(login),
    };
  });
  const agents = new Map<string, AccountView[]>();
  for (const account of accounts)
    if (account.provider === "acp")
      agents.set(account.providerLabel, [...(agents.get(account.providerLabel) ?? []), account]);
  const acp = [...agents].map(([name, own]): ProviderInstall => ({
    kind: "acp",
    name,
    binary: name,
    version: own.find((a) => a.version)?.version ?? "",
    via: "via ACP",
    accounts: own.map(login),
  }));
  return [...native, ...acp];
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
 * providers from `accounts.list`, models from `models.list` / `models.refresh`. Machines, devices
 * and ACP agents added by command go through `access` until the daemon serves them.
 */
export function daemonSettingsBackend(
  client: ClientApi,
  options: { access: AccessSource; defaults: Readonly<Record<string, unknown>> },
): SettingsBackend {
  const { access, defaults } = options;
  const values = daemonValues(client, Object.keys(defaults));
  const providers = async () => {
    const reply = await client.request({ type: "accounts.list" });
    const added = (await access.acpAgents()).map((agent): ProviderInstall => ({
      kind: "acp",
      name: agent.name,
      binary: agent.binary,
      version: null,
      via: "via ACP",
      accounts: [],
    }));
    return [...providerInstalls(reply.accounts.map(accountView)), ...added];
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
    addAcpAgent: (agent) => access.addAcpAgent(agent),
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
