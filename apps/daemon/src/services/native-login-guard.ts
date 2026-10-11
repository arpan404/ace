import type { AccountRegistry } from "@ace/accounts";
import type { ModelCatalog } from "@ace/models";
import type { ProviderInstance } from "@ace/protocol/accounts";
import { sameProviderExecutableConfiguration } from "../provider-discovery.ts";
import type { ProviderConfigurationsState } from "../provider-configurations.ts";

/** A native login owns one effective executable/account generation until it releases its lease. */
export function nativeLoginGuard(
  instance: ProviderInstance,
  registry: AccountRegistry,
  configurations: ProviderConfigurationsState | undefined,
  signal: AbortSignal,
  models?: ModelCatalog,
) {
  const configuration = { ...configurations?.for(instance.provider, instance.id) };
  const selected = registry.selectedProvider(instance.provider);
  let revision = instance.loginRevision ?? "0";
  let catalogOwned = false;
  let cleanup: Promise<void> | undefined;
  const controller = new AbortController();
  const ownedSignal = AbortSignal.any([signal, controller.signal]);
  const current = () => {
    const account = registry.get(instance.id)?.instance;
    return (
      registry.selectedProvider(instance.provider) === selected &&
      account?.provider === instance.provider &&
      account.homeDir === instance.homeDir &&
      (account.loginRevision ?? "0") === revision &&
      sameProviderExecutableConfiguration(
        configuration,
        configurations?.for(instance.provider, instance.id),
      )
    );
  };
  const removeCatalog = () => {
    if (!catalogOwned || !models || cleanup) return;
    // Removal revokes the in-memory catalog synchronously, then drains discovery and storage.
    try {
      cleanup = models.removeInstance(instance.id);
    } catch (error) {
      cleanup = Promise.reject(error);
    }
    void cleanup.catch(() => {});
  };
  const cancel = () => {
    if (controller.signal.aborted) return;
    controller.abort(new Error("Provider configuration or account revision changed"));
    const account = registry.get(instance.id);
    try {
      if (
        configuration.binaryPath !==
          configurations?.for(instance.provider, instance.id)?.binaryPath &&
        account?.quota.auth === "logged_in"
      )
        registry.invalidateAuth(instance.id, revision);
    } finally {
      removeCatalog();
    }
  };
  const stop = configurations?.listen(() => {
    if (!current()) cancel();
  });
  return {
    configuration,
    signal: ownedSignal,
    assertCurrent() {
      if (!current()) cancel();
      ownedSignal.throwIfAborted();
    },
    acceptRevision() {
      // Auth ingestion or the explicit login-change below advances this operation exactly once.
      revision = String(Number(revision) + 1);
      if (!current()) cancel();
      ownedSignal.throwIfAborted();
    },
    ownCatalog() {
      catalogOwned = true;
    },
    async drain() {
      if (controller.signal.aborted) removeCatalog();
      try {
        await cleanup;
      } catch (error) {
        cleanup = undefined;
        throw error;
      }
    },
    dispose() {
      stop?.();
    },
  };
}
