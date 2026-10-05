import type { AdapterRegistry } from "../engine/registry.ts";
import { daemonCursorInstance } from "./cursor-instance.ts";
import { startCursorAuth } from "./cursor-auth.ts";
import type { ServiceContext } from "./types.ts";

/** The SDK catalog follows the selected SDK account, else the daemon-owned SDK home. */
export function cursorSdkCatalogInstance(context: ServiceContext) {
  const registry = context.services.accountRegistry;
  const selected = registry?.selectedCursorSdk();
  return (
    (selected ? registry?.get(selected)?.instance : undefined) ?? daemonCursorInstance(context)
  );
}

/** Registers the SDK catalog row; account-owned homes are revalidated before discovery. */
export function registerCursorSdkCatalog(
  context: ServiceContext,
  instance: { id: string; homeDir: string },
): void {
  const { services } = context;
  services.models?.registerInstance(
    {
      id: instance.id,
      provider: "cursor",
      backend: "cursor-sdk",
      homeDir: instance.homeDir,
      cwd: instance.homeDir,
      loginRevision: "cursor-sdk-default-v1",
    },
    async () => {
      const account = services.accountRegistry?.get(instance.id)?.instance;
      if (account) await services.accountRegistry?.validateHome(account);
    },
  );
}

/** Startup and enablement use the same admission; existing account/session owners stay intact. */
export async function activateCursorProvider(
  context: ServiceContext,
  adapters: AdapterRegistry,
): Promise<void> {
  const { services, options } = context;
  if (
    services.providerConfigurations?.for("cursor").enabled === false ||
    !services.accountRegistry ||
    !services.cursorAccounts ||
    !adapters.has("cursor") ||
    adapters.get("cursor").adapter.backend !== "cursor-sdk"
  )
    return;
  context.signal.throwIfAborted();
  const instance = cursorSdkCatalogInstance(context);
  if (options.modelInstances === undefined && !services.models?.hasInstance(instance.id))
    registerCursorSdkCatalog(context, instance);
  startCursorAuth(context);
}
