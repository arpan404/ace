import { subscribeSettings } from "@/lib/settings-subscription.ts";
import type { ClientApi } from "@ace/client";
import { JsonValue, SettingsKey, type SettingsEntry } from "@ace/protocol";
import type { SettingsValuesMap, ValuesStore } from "./backend.ts";

/** `settings.subscribe` takes at most 32 keys per subscription. */
const maxKeys = 32;

export interface DaemonValues extends ValuesStore {
  set(key: string, value: unknown): Promise<void>;
}

/** `keys` in groups the daemon takes in one subscription. */
function groupsOf(keys: readonly SettingsKey[]): SettingsKey[][] {
  const groups: SettingsKey[][] = [];
  for (let at = 0; at < keys.length; at += maxKeys) groups.push(keys.slice(at, at + maxKeys));
  return groups;
}

/**
 * A live mirror of the daemon's settings for the keys Settings edits: a `settings.subscribe`
 * per 32 keys per connection, renewed after every reconnect, then `settings.changed` pushes.
 * Writes go to the global layer and resolve once the daemon has stored them. A key outside the
 * daemon's schema is refused here, before it reaches the wire: nothing is held only for this
 * session.
 */
export function daemonValues(client: ClientApi, keys: readonly string[]): DaemonValues {
  const watched = keys.flatMap((key) => {
    const parsed = SettingsKey.safeParse(key);
    return parsed.success ? [parsed.data] : [];
  });
  const listeners = new Set<() => void>();
  let values: SettingsValuesMap = {};
  let subscriptions: ReturnType<typeof subscribeSettings>[] | undefined;
  // The groups whose last read failed; the mirror has failed while any has.
  const failing = new Set<number>();

  const emit = () => {
    for (const listener of listeners) listener();
  };
  const apply = (
    entries: readonly SettingsEntry[],
    replaced: readonly SettingsKey[] | undefined,
  ) => {
    const next: Record<string, unknown> = { ...values };
    for (const key of replaced ?? []) delete next[key];
    for (const entry of entries) next[entry.key] = entry.value;
    values = next;
    emit();
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      subscriptions ??= groupsOf(watched).map((group, index) =>
        subscribeSettings(
          client,
          group,
          {},
          (entries, replace) => {
            failing.delete(index);
            apply(entries, replace ? group : undefined);
          },
          () => {
            failing.add(index);
            emit();
          },
        ),
      );
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          for (const subscription of subscriptions ?? []) subscription.stop();
          subscriptions = undefined;
          failing.clear();
        }
      };
    },
    get: () => values,
    failed: () => failing.size > 0,
    retry: () => {
      for (const subscription of subscriptions ?? []) subscription.retry();
    },
    async set(key, value) {
      const parsedKey = SettingsKey.safeParse(key);
      if (!parsedKey.success)
        throw new Error("That setting is unavailable. Update ace and try again.");
      const json = JsonValue.parse(value);
      // Optimistic: the page shows the new value at once and goes back if the daemon refuses.
      const before = values;
      apply([{ key: parsedKey.data, value: json, provenance: "global" }], undefined);
      const refused = (message: string) => {
        if (values[key] === json) {
          values = { ...values, [key]: before[key] };
          emit();
        }
        return new Error(message);
      };
      const reply = await client
        .request({ type: "settings.set", key, value: json, layer: { kind: "global" } })
        .catch(() => {
          throw refused("Couldn't reach ace to save that.");
        });
      if (!reply.ok) throw refused("Couldn't save that setting. Check the value and try again.");
      if (reply.entries.length) apply(reply.entries, undefined);
    },
  };
}
