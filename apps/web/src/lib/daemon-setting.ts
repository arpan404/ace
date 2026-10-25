import { subscribeSettings } from "./settings-subscription.ts";
import type { ClientApi } from "@ace/client";
import { useClient } from "@ace/client-react";
import type {
  SettingsValues,
  SettingsEntry,
  SettingsKey,
  SettingsLayer,
  SettingsProvenance,
  SettingsScope,
} from "@ace/protocol";
import { useCallback, useSyncExternalStore } from "react";

type Value<K extends SettingsKey> = SettingsValues[K];

/** Starts loading with this module, so it is usually there before the daemon first answers. */
const schemas = import("./settings-schemas.ts");

/**
 * One daemon setting resolved for a scope, kept live: a `settings.subscribe` for that key while
 * someone reads it, renewed after every reconnect, then `settings.changed` pushes. Values are
 * parsed with the protocol schema; an unknown or invalid value reads as undefined.
 */
class SettingWatch {
  private value: unknown;
  private localValue: unknown;
  /** The layer the value came from; `defaults` means nobody has set it. */
  private provenance: SettingsProvenance | undefined;
  private listeners = new Set<() => void>();
  private stops: (() => void)[] = [];
  private failed = false;
  private readonly client: ClientApi;
  private readonly key: SettingsKey;
  private readonly scope: SettingsScope;
  private readonly owner: { active(watch: SettingWatch): void; empty(watch: SettingWatch): void };
  constructor(
    client: ClientApi,
    key: SettingsKey,
    scope: SettingsScope,
    owner: { active(watch: SettingWatch): void; empty(watch: SettingWatch): void },
  ) {
    this.client = client;
    this.key = key;
    this.scope = scope;
    this.owner = owner;
  }
  getFailed = (): boolean => this.failed;
  get = (): unknown => this.value;
  getLocal = (): unknown => this.localValue;
  getProvenance = (): SettingsProvenance | undefined => this.provenance;
  subscribe = (listener: () => void): (() => void) => {
    if (!this.listeners.size) {
      this.owner.active(this);
      this.start();
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) this.stop();
    };
  };
  /** Pushes wait for the schemas in arrival order: they share one promise. */
  private receive(entries: readonly SettingsEntry[]) {
    void schemas.then(({ SettingsValues }) => this.apply(SettingsValues, entries));
  }
  private apply(values: typeof SettingsValues, entries: readonly SettingsEntry[]) {
    this.failed = false;
    const entry = entries.find((candidate) => candidate.key === this.key);
    if (!entry) return;
    const parsed = values.shape[this.key].safeParse(entry.value);
    this.value = parsed.success ? parsed.data : undefined;
    this.provenance = entry.provenance;
    this.localValue = entry.localValue;
    for (const listener of this.listeners) listener();
  }
  private start() {
    const subscription = subscribeSettings(
      this.client,
      [this.key],
      this.scope,
      (entries) => this.receive(entries),
      () => {
        this.failed = true;
        for (const listener of this.listeners) listener();
      },
    );
    this.stops.push(subscription.stop);
  }
  private stop() {
    for (const stop of this.stops.splice(0)) stop();
    this.owner.empty(this);
  }
}

const watches = new WeakMap<ClientApi, Map<string, SettingWatch>>();

function watchFor(client: ClientApi, key: SettingsKey, scope: SettingsScope): SettingWatch {
  let byKey = watches.get(client);
  if (!byKey) {
    byKey = new Map();
    watches.set(client, byKey);
  }
  const id = `${key}|${scope.workspaceId ?? ""}|${scope.threadId ?? ""}`;
  let watch = byKey.get(id);
  if (!watch) {
    const map = byKey;
    // A remount can stop one watch after its replacement was made: each keeps or leaves its own
    // place only, so readers never churn through fresh, empty watches.
    watch = new SettingWatch(client, key, scope, {
      active: (started) => {
        if (!map.has(id)) map.set(id, started);
      },
      empty: (stopped) => {
        if (map.get(id) === stopped) map.delete(id);
      },
    });
    byKey.set(id, watch);
  }
  return watch;
}

/**
 * A daemon setting as the daemon resolves it for `scope` (thread over workspace over global over
 * defaults), and a way to store a new value on a layer (global unless given). Undefined until the
 * daemon has answered.
 */
export function useDaemonSetting<K extends SettingsKey>(
  key: K,
  scope: SettingsScope = {},
): [Value<K> | undefined, (value: Value<K>, layer?: SettingsLayer) => Promise<void>] {
  const client = useClient();
  const watch = watchFor(client, key, scope);
  // The watch keeps only values its key's schema accepted, so what it holds is already a Value<K>.
  const value = useSyncExternalStore(watch.subscribe, watch.get, watch.get) as Value<K> | undefined;
  const set = useCallback(
    async (stored: Value<K>, layer: SettingsLayer = { kind: "global" }) => {
      const { SettingsSet } = await schemas;
      const reply = await client.request({
        type: "settings.set",
        key,
        value: SettingsSet.shape.value.parse(stored),
        layer,
      });
      if (!reply.ok) throw new Error("Couldn't save that setting. Check the value and try again.");
    },
    [client, key],
  );
  return [value, set];
}

/**
 * A daemon setting only when someone has set it on a layer the scope reaches: undefined while
 * the daemon reports its shipped default, so a schema default is never taken for a choice.
 * `loaded` is false until the daemon has answered.
 */
export function useExplicitDaemonSetting<K extends SettingsKey>(
  key: K,
  scope: SettingsScope = {},
): { value: Value<K> | undefined; loaded: boolean } {
  const client = useClient();
  const watch = watchFor(client, key, scope);
  const [value] = useDaemonSetting(key, scope);
  const provenance = useSyncExternalStore(
    watch.subscribe,
    watch.getProvenance,
    watch.getProvenance,
  );
  const failed = useSyncExternalStore(watch.subscribe, watch.getFailed, watch.getFailed);
  return {
    value: provenance === undefined || provenance === "defaults" ? undefined : value,
    loaded: provenance !== undefined || failed,
  };
}

/** Where a daemon setting's value comes from; `environment` means a host variable pins it. */
export function useDaemonSettingProvenance(
  key: SettingsKey,
  scope: SettingsScope = {},
): SettingsProvenance | undefined {
  const client = useClient();
  const watch = watchFor(client, key, scope);
  return useSyncExternalStore(watch.subscribe, watch.getProvenance, watch.getProvenance);
}
