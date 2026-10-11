import type { AccountRegistry } from "@ace/accounts";
import type { ProviderInstance } from "@ace/protocol/accounts";
import { sameProviderExecutableConfiguration } from "../provider-discovery.ts";
import type { ProviderConfigurationsState } from "../provider-configurations.ts";

/** A native login owns one effective executable/account generation until it releases its lease. */
export function nativeLoginGuard(
  instance: ProviderInstance,
  registry: AccountRegistry,
  configurations: ProviderConfigurationsState | undefined,
  signal: AbortSignal,
) {
  const configuration = { ...configurations?.for(instance.provider, instance.id) };
  let revision = instance.loginRevision;
  const controller = new AbortController();
  const ownedSignal = AbortSignal.any([signal, controller.signal]);
  const current = () => {
    const account = registry.get(instance.id)?.instance;
    return account?.provider === instance.provider && account.homeDir === instance.homeDir &&
      account.loginRevision === revision && sameProviderExecutableConfiguration(
        configuration, configurations?.for(instance.provider, instance.id),
      );
  };
  const cancel = () => controller.abort(new Error("Provider configuration or account revision changed"));
  const stop = configurations?.listen(() => { if (!current()) cancel(); });
  return {
    configuration,
    signal: ownedSignal,
    assertCurrent() {
      if (!current()) cancel();
      ownedSignal.throwIfAborted();
    },
    acceptRevision() {
      revision = registry.get(instance.id)?.instance.loginRevision ?? revision;
    },
    dispose() { stop?.(); },
  };
}
