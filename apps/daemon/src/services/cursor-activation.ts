import { createInstance } from "@ace/accounts";
import type { AdapterRegistry } from "../engine/registry.ts";
import { daemonCursorInstance } from "./cursor-instance.ts";
import { startCursorAuth } from "./cursor-auth.ts";
import type { ServiceContext } from "./types.ts";

/** Startup and enablement use the same admission; existing account/session owners stay intact. */
export async function activateCursorProvider(
  context: ServiceContext,
  adapters: AdapterRegistry,
): Promise<void> {
  const { services, options } = context;
  const registry = services.accountRegistry;
  if (
    services.providerConfigurations?.for("cursor").enabled === false ||
    !registry ||
    !services.cursorAccounts ||
    !adapters.has("cursor") ||
    adapters.get("cursor").adapter.backend !== "cursor-sdk"
  )
    return;
  const fallback = daemonCursorInstance(context);
  if (
    !registry.get(fallback.id) &&
    !registry.list().some(({ instance }) => instance.provider === "cursor" && !instance.implicit)
  )
    await registry.register(
      createInstance({ ...fallback, provider: "cursor", label: "Cursor SDK" }),
    );
  context.signal.throwIfAborted();
  if (services.providerConfigurations?.for("cursor").enabled === false) return;
  const selected =
    services.accounts?.preferredCursorInstance() ??
    registry.list().find(({ instance }) => instance.provider === "cursor")?.instance.id;
  const instance = selected ? registry.get(selected)?.instance : undefined;
  const models = services.models;
  if (
    instance &&
    models &&
    options.modelInstances === undefined &&
    !models.hasInstance(instance.id)
  )
    models.registerInstance({
      id: instance.id,
      provider: "cursor",
      backend: "cursor-sdk",
      homeDir: instance.homeDir,
      cwd: instance.homeDir,
      loginRevision: "cursor-sdk-default-v1",
    });
  startCursorAuth(context);
}
