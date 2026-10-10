import { subscribeSettings } from "@/lib/settings-subscription.ts";
import type { ClientApi } from "@ace/client";
import { SettingsKey, type SettingsEntry } from "@ace/protocol";
import { z } from "zod";
import type { SettingsValuesMap, ValuesStore } from "./backend.ts";

/** `settings.subscribe` takes at most 32 keys per subscription. */
const maxKeys = 32;

export interface DaemonValues extends ValuesStore {
  set(key: string, value: unknown): Promise<void>;
}

/**
 * A live mirror of the daemon's settings for the keys Settings edits: one `settings.subscribe`
 * per connection, renewed after every reconnect, then `settings.changed` pushes. Writes go to the
 * global layer and resolve once the daemon has stored them. A key outside the daemon's schema
 * is refused here, before it reaches the wire: nothing is held only for this session.
 */
export function daemonValues(client: ClientApi, keys: readonly string[]): DaemonValues {
  const watched = keys
    .flatMap((key) => {
      const parsed = SettingsKey.safeParse(key);
      return parsed.success ? [parsed.data] : [];
    })
    .slice(0, maxKeys);
  const listeners = new Set<() => void>();
  let values: SettingsValuesMap = {};
  let subscription: ReturnType<typeof subscribeSettings> | undefined;
  let failed = false;

  const emit = () => {
    for (const listener of listeners) listener();
  };
  const apply = (entries: readonly SettingsEntry[], replace: boolean) => {
    const next: Record<string, unknown> = { ...values };
    if (replace) for (const key of watched) delete next[key];
    for (const entry of entries) next[entry.key] = entry.value;
    values = next;
    emit();
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      subscription ??= subscribeSettings(
        client,
        watched,
        {},
        (entries, replace) => {
          failed = false;
          apply(entries, replace);
        },
        () => {
          failed = true;
          emit();
        },
      );
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          subscription?.stop();
          subscription = undefined;
        }
      };
    },
    get: () => values,
    failed: () => failed,
    retry: () => subscription?.retry(),
    async set(key, value) {
      const parsedKey = SettingsKey.safeParse(key);
      if (!parsedKey.success)
        throw new Error("That setting is unavailable. Update ace and try again.");
      const json = z.json().parse(value);
      // Optimistic: the page shows the new value at once and goes back if the daemon refuses.
      const before = values;
      apply([{ key: parsedKey.data, value: json, provenance: "global" }], false);
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
      if (reply.entries.length) apply(reply.entries, false);
    },
  };
}
