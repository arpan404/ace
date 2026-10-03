import type { ClientApi } from "@ace/client";
import { useClient } from "@ace/client-react";
import type { ProviderKind } from "@ace/protocol";
import { use, useCallback, useMemo, useSyncExternalStore } from "react";
import { useDaemonConnection } from "@/boot/connection.tsx";
import type { SettingsBackend } from "./backend.ts";
import { pendingSettingsBackend } from "./pending-backend.ts";
import type { SettingDef } from "./setting-keys.ts";

const backends = new WeakMap<ClientApi, SettingsBackend>();
type FakeModule = typeof import("./fake-backend.ts");
let fakeModule: Promise<FakeModule> | undefined;

/** The fake daemon's fixture is loaded on demand, so real-daemon builds never run it. */
function loadFake(): Promise<FakeModule> {
  return (fakeModule ??= import("./fake-backend.ts"));
}

/** The browser's clock and randomness, injected at this boundary. */
function fakeWithBrowserClock(module: FakeModule): SettingsBackend {
  return module.fakeSettingsBackend({ now: () => Date.now(), random: () => Math.random() });
}

/**
 * The settings backend for the current daemon client: one per client, so it outlives page
 * changes and is replaced with the client when the user connects elsewhere. Suspends once
 * while the fake backend loads.
 */
export function useSettingsBackend(): SettingsBackend {
  const client = useClient();
  const fake = useDaemonConnection().mode === "fake";
  const module = fake ? use(loadFake()) : undefined;
  let backend = backends.get(client);
  if (!backend) {
    // TODO(train-2): wire to protocol when merged (daemonBackend(client) for real daemons).
    backend = module ? fakeWithBrowserClock(module) : pendingSettingsBackend();
    backends.set(client, backend);
  }
  return backend;
}

/**
 * One daemon setting, parsed at the boundary. Unknown or invalid stored values read as the
 * fallback, so a bad write from another client can never break the page.
 */
export function useSetting<T>(setting: SettingDef<T>): [T, (value: T) => Promise<void>] {
  const { key, schema, fallback } = setting;
  const backend = useSettingsBackend();
  const raw = useSyncExternalStore(
    backend.values.subscribe,
    () => backend.values.get()[key],
    () => backend.values.get()[key],
  );
  const value = useMemo(() => {
    const parsed = raw === undefined ? undefined : schema.safeParse(raw);
    return parsed?.success ? parsed.data : fallback;
  }, [raw, schema, fallback]);
  const set = useCallback((next: T) => backend.set(key, next), [backend, key]);
  return [value, set];
}

/** Request/response reads. Live values never enter the Query cache; these are one-off lists. */
export const settingsQueries = {
  providers: (backend: SettingsBackend) => ({
    queryKey: ["settings", "providers"] as const,
    queryFn: () => backend.providers(),
  }),
  models: (backend: SettingsBackend, provider: ProviderKind) => ({
    queryKey: ["settings", "models", provider] as const,
    queryFn: () => backend.models(provider),
  }),
  machines: (backend: SettingsBackend) => ({
    queryKey: ["settings", "machines"] as const,
    queryFn: () => backend.machines(),
  }),
  devices: (backend: SettingsBackend) => ({
    queryKey: ["settings", "devices"] as const,
    queryFn: () => backend.devices(),
  }),
};
