import type { Client } from "@ace/client";
import { useClient } from "@ace/client-react";
import type { ProviderKind } from "@ace/protocol";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { SettingsBackend } from "./backend.ts";
import type { SettingDef } from "./setting-keys.ts";
import { fakeSettingsBackend } from "./fake-backend.ts";

const backends = new WeakMap<Client, SettingsBackend>();

/** The browser's clock and randomness, injected at this boundary. */
function createBackend(): SettingsBackend {
  return fakeSettingsBackend({ now: () => Date.now(), random: () => Math.random() });
}

/**
 * The settings backend for the current daemon client: one per client, so it outlives page
 * changes and is replaced with the client when the user connects elsewhere.
 */
export function useSettingsBackend(): SettingsBackend {
  const client = useClient();
  let backend = backends.get(client);
  if (!backend) {
    // TODO(train-2): wire to protocol when merged (daemonBackend(client) instead of the fake).
    backend = createBackend();
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
