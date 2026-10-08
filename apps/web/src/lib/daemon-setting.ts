import type { ClientApi } from "@ace/client";
import { useClient } from "@ace/client-react";
import {
  SettingsValues,
  type SettingsEntry,
  type SettingsKey,
  type SettingsLayer,
  type SettingsProvenance,
  type SettingsScope,
} from "@ace/protocol";
import { useCallback, useSyncExternalStore } from "react";

type Value<K extends SettingsKey> = SettingsValues[K];

/**
 * One daemon setting resolved for a scope, kept live: a `settings.subscribe` for that key while
 * someone reads it, renewed after every reconnect, then `settings.changed` pushes. Values are
 * parsed with the protocol schema; an unknown or invalid value reads as undefined.
 */
class SettingWatch {
  private value: unknown;
  /** The layer the value came from; `defaults` means nobody has set it. */
  private provenance: SettingsProvenance | undefined;
  private listeners = new Set<() => void>();
  private stops: (() => void)[] = [];
  private subscribed = false;
  private readonly client: ClientApi;
  private readonly key: SettingsKey;
  private readonly scope: SettingsScope;
  private readonly subscriptionId: string;
  private readonly onEmpty: () => void;
  constructor(
    client: ClientApi,
    key: SettingsKey,
    scope: SettingsScope,
    subscriptionId: string,
    onEmpty: () => void,
  ) {
    this.client = client;
    this.key = key;
    this.scope = scope;
    this.subscriptionId = subscriptionId;
    this.onEmpty = onEmpty;
  }
  get = (): unknown => this.value;
  getProvenance = (): SettingsProvenance | undefined => this.provenance;
  subscribe = (listener: () => void): (() => void) => {
    if (!this.listeners.size) this.start();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) this.stop();
    };
  };
  private apply(entries: readonly SettingsEntry[]) {
    const entry = entries.find((candidate) => candidate.key === this.key);
    if (!entry) return;
    const parsed = SettingsValues.shape[this.key].safeParse(entry.value);
    this.value = parsed.success ? parsed.data : undefined;
    this.provenance = entry.provenance;
    for (const listener of this.listeners) listener();
  }
  private ask() {
    if (this.subscribed || this.client.state !== "ready") return;
    this.subscribed = true;
    this.client
      .request({
        type: "settings.subscribe",
        subscriptionId: this.subscriptionId,
        keys: [this.key],
        scope: this.scope,
      })
      .then((reply) => this.apply(reply.entries))
      .catch(() => {
        this.subscribed = false;
      });
  }
  private start() {
    this.stops.push(
      this.client.onMessage((message) => {
        if (message.type === "settings.changed" && message.subscriptionId === this.subscriptionId)
          this.apply(message.entries);
      }),
    );
    const connection = this.client.connectionState();
    this.stops.push(
      connection.subscribe(() => {
        // A new socket has no subscriptions; ask again once it is ready.
        if (connection.getSnapshot() !== "ready") this.subscribed = false;
        else this.ask();
      }),
    );
    this.ask();
  }
  private stop() {
    for (const stop of this.stops.splice(0)) stop();
    if (this.subscribed && this.client.state === "ready")
      void this.client
        .request({ type: "settings.unsubscribe", subscriptionId: this.subscriptionId })
        .catch(() => {});
    this.subscribed = false;
    this.onEmpty();
  }
}

const watches = new WeakMap<ClientApi, Map<string, SettingWatch>>();
let next = 0;

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
    watch = new SettingWatch(client, key, scope, `web-setting-${++next}`, () => map.delete(id));
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
  const raw = useSyncExternalStore(watch.subscribe, watch.get, watch.get);
  const parsed = SettingsValues.shape[key].safeParse(raw);
  const value = raw === undefined || !parsed.success ? undefined : (parsed.data as Value<K>);
  const set = useCallback(
    async (stored: Value<K>, layer: SettingsLayer = { kind: "global" }) => {
      const reply = await client.request({ type: "settings.set", key, value: stored, layer });
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
  return {
    value: provenance === undefined || provenance === "defaults" ? undefined : value,
    loaded: provenance !== undefined,
  };
}
