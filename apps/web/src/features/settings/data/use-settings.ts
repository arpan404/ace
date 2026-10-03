import type { ClientApi } from "@ace/client";
import { useClient } from "@ace/client-react";
import type { ProviderKind } from "@ace/protocol";
import { use, useCallback, useMemo, useSyncExternalStore } from "react";
import { useDaemonConnection } from "@/boot/connection.tsx";
import type { SettingsBackend } from "./backend.ts";
import { unavailableAccess } from "./access-source.ts";
import { daemonSettingsBackend } from "./daemon-backend.ts";
import { settingKeys, type SettingDef } from "./setting-keys.ts";

const backends = new WeakMap<ClientApi, SettingsBackend>();
type FakeAccessModule = typeof import("./access-fake.ts");
let fakeModule: Promise<FakeAccessModule> | undefined;

/** The fake daemon's access fixture is loaded on demand, so real-daemon builds never run it. */
function loadFake(): Promise<FakeAccessModule> {
  return (fakeModule ??= import("./access-fake.ts"));
}

/** The browser's clock and randomness, injected at this boundary. */
function withBrowserClock(module: FakeAccessModule) {
  return module.fakeAccess({ now: () => Date.now(), random: () => Math.random() });
}

const defaults = Object.fromEntries(
  Object.values(settingKeys).map((setting): [string, unknown] => [setting.key, setting.fallback]),
);

/**
 * The settings backend for the current daemon client: one per client, so it outlives page
 * changes and is replaced with the client when the user connects elsewhere. Suspends once in
 * fake mode while the access stand-in loads.
 */
export function useSettingsBackend(): SettingsBackend {
  const client = useClient();
  const fake = useDaemonConnection().mode === "fake";
  const module = fake ? use(loadFake()) : undefined;
  let backend = backends.get(client);
  if (!backend) {
    const access = module ? withBrowserClock(module) : unavailableAccess();
    backend = daemonSettingsBackend(client, { access, defaults });
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
