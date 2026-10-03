import type { ClientApi } from "@ace/client";
import { SettingsKey, type SettingsEntry } from "@ace/protocol";
import { z } from "zod";
import type { SettingsValuesMap, ValuesStore } from "./backend.ts";

/** `settings.subscribe` takes at most 32 keys per subscription. */
const maxKeys = 32;

export interface DaemonValues extends ValuesStore {
  set(key: string, value: unknown): Promise<void>;
}

/** Whether the daemon's settings schema knows this key; unknown keys are refused there. */
export const isDaemonKey = (key: string) => SettingsKey.safeParse(key).success;

/**
 * A live mirror of the daemon's settings for the keys Settings edits: one `settings.subscribe`
 * per connection, renewed after every reconnect, then `settings.changed` pushes. Writes go to the
 * global layer and resolve once the daemon has stored them.
 *
 * Keys the daemon's schema doesn't have yet are held for this session only.
 * TODO(client-gaps): feat/client-protocol-gaps adds them to SettingsValues; they then route to
 * the daemon with no change here.
 */
export function daemonValues(client: ClientApi, keys: readonly string[]): DaemonValues {
  const watched = keys
    .flatMap((key) => {
      const parsed = SettingsKey.safeParse(key);
      return parsed.success ? [parsed.data] : [];
    })
    .slice(0, maxKeys);
  const subscriptionId = "web-settings";
  const listeners = new Set<() => void>();
  let values: SettingsValuesMap = {};
  let started = false;
  let subscribed = false;

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
  const subscribe = () => {
    if (subscribed || client.state !== "ready" || !watched.length) return;
    subscribed = true;
    client
      .request({ type: "settings.subscribe", subscriptionId, keys: watched, scope: {} })
      .then((reply) => apply(reply.entries, true))
      .catch(() => {
        subscribed = false;
      });
  };
  const start = () => {
    if (started) return;
    started = true;
    client.onMessage((message) => {
      if (message.type === "settings.changed" && message.subscriptionId === subscriptionId)
        apply(message.entries, false);
    });
    const connection = client.connectionState();
    connection.subscribe(() => {
      // A new socket has no subscriptions; ask again once it is ready.
      if (connection.getSnapshot() !== "ready") subscribed = false;
      else subscribe();
    });
    subscribe();
  };

  return {
    subscribe(listener) {
      start();
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    get: () => values,
    async set(key, value) {
      if (!isDaemonKey(key)) {
        values = { ...values, [key]: value };
        emit();
        return;
      }
      const json = z.json().parse(value);
      const parsedKey = SettingsKey.parse(key);
      // Optimistic: the page shows the new value at once and goes back if the daemon refuses.
      const before = values;
      apply([{ key: parsedKey, value: json, provenance: "global" }], false);
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
          throw refused("Couldn't reach the daemon to save that.");
        });
      if (!reply.ok)
        throw refused(reply.diagnostics[0]?.message ?? "The daemon refused that value.");
      if (reply.entries.length) apply(reply.entries, false);
    },
  };
}
