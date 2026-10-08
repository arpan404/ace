import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ClientApi } from "@ace/client";
import { useClient, useConnectionState } from "@ace/client-react";
import {
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { useDaemonConnection } from "@/boot/connection.tsx";
import { UnavailableError } from "@/boot/fake-backend.ts";
import type { SettingsBackend } from "./backend.ts";
import { unavailableGaps } from "./access-gaps.ts";
import { accessSource } from "./access-source.ts";
import { daemonSettingsBackend } from "./daemon-backend.ts";
import { settingKeys, type SettingDef } from "./setting-keys.ts";

const backends = new WeakMap<ClientApi, SettingsBackend>();
type FakeAccessModule = typeof import("./access-fake.ts");
let fakeModule: Promise<FakeAccessModule> | undefined;

/** The fake machines and ACP agents are loaded on demand, so real-daemon builds never run them. */
function loadFake(): Promise<FakeAccessModule> {
  return (fakeModule ??= import("./access-fake.ts"));
}

/** The browser's clock, injected at this boundary. */
function withBrowserClock(module: FakeAccessModule) {
  return module.fakeGaps({ now: () => Date.now() });
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
  const connection = useDaemonConnection();
  const module = connection.mode === "fake" ? use(loadFake()) : undefined;
  let backend = backends.get(client);
  if (!backend) {
    const gaps = module ? withBrowserClock(module) : unavailableGaps();
    const access = accessSource(connection.endpoint, gaps);
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
  const queries = useQueryClient();
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
  const set = useCallback(
    async (next: T) => {
      await backend.set(key, next);
      if (key.startsWith("remote."))
        await queries.invalidateQueries({ queryKey: ["settings", "remote-status"] });
      if (key === "host.displayName")
        await queries.invalidateQueries({ queryKey: ["machines", "identity"] });
    },
    [backend, key, queries],
  );
  return [value, set];
}

/** Whether the daemon has answered for these settings yet (the first subscribe reply). */
export function useSettingsLoaded(): boolean {
  const backend = useSettingsBackend();
  return useSyncExternalStore(
    backend.values.subscribe,
    () => Object.keys(backend.values.get()).length > 0,
    () => Object.keys(backend.values.get()).length > 0,
  );
}

/** How long a write may take before its control shows a spinner. */
const pendingAfterMs = 400;

/**
 * Report a settings write: nothing while it goes well (changes apply at once), a spinner if it
 * takes longer than 400ms, and a toast with Retry if the daemon refuses it or can't be reached.
 * The value itself goes back on failure (the store rolls back).
 */
export function useSettingWrite(title: string) {
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const inFlight = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const run = useCallback(
    (write: () => Promise<void>) => {
      const attempt = () => {
        inFlight.current += 1;
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setPending(inFlight.current > 0), pendingAfterMs);
        const done = () => {
          inFlight.current -= 1;
          if (inFlight.current > 0) return;
          clearTimeout(timer.current);
          setPending(false);
        };
        write().then(done, (error: unknown) => {
          done();
          toast.error({
            title: `Couldn't save "${title}"`,
            description: error instanceof Error ? error.message : undefined,
            actionProps: { children: "Retry", onClick: attempt },
          });
        });
      };
      attempt();
    },
    [toast, title],
  );
  return { run, pending };
}

/** A daemon setting's control: its value, whether it can change now, and a reported write. */
export interface SettingControl<T> {
  value: T;
  /** The daemon has answered; before that the value is only the fallback. */
  loaded: boolean;
  /** Not connected: daemon settings can't change. */
  offline: boolean;
  /** A write has taken longer than 400ms. */
  pending: boolean;
  set(next: T): void;
}

/** One daemon setting for a settings row titled `title` (the error toast names it). */
export function useSettingControl<T>(setting: SettingDef<T>, title: string): SettingControl<T> {
  const [value, set] = useSetting(setting);
  const backend = useSettingsBackend();
  const loaded = useSyncExternalStore(
    backend.values.subscribe,
    () => setting.key in backend.values.get(),
    () => setting.key in backend.values.get(),
  );
  const offline = useConnectionState() !== "ready";
  const write = useSettingWrite(title);
  return {
    value,
    loaded,
    offline,
    pending: write.pending,
    set: (next) => write.run(() => set(next)),
  };
}

/** Request/response reads. Live values never enter the Query cache; these are one-off lists. */
export const settingsQueries = {
  providers: (backend: SettingsBackend) => ({
    queryKey: ["settings", "providers"] as const,
    queryFn: () => backend.providers(),
  }),
  machines: (backend: SettingsBackend) => ({
    queryKey: ["settings", "machines"] as const,
    queryFn: () => backend.machines(),
    // A daemon that can't list machines won't on a second ask either.
    retry: (count: number, error: Error) => !(error instanceof UnavailableError) && count < 1,
  }),
  devices: (backend: SettingsBackend) => ({
    queryKey: ["settings", "devices"] as const,
    queryFn: () => backend.devices(),
  }),
};

/** Actual listeners and launch overrides, shared by remote controls and pairing. */
export function useRemoteStatus() {
  const backend = useSettingsBackend();
  const enabled = useSettingControl(settingKeys.remoteEnabled, "Remote access");
  const transport = useSettingControl(settingKeys.remoteTransport, "Transport");
  const relay = useSettingControl(settingKeys.relayUrl, "Relay address");
  return useQuery({
    queryKey: ["settings", "remote-status", enabled.value, transport.value, relay.value],
    enabled: enabled.loaded && transport.loaded && relay.loaded,
    staleTime: 0,
    queryFn: () => backend.remoteStatus(),
    retry: false,
  });
}
