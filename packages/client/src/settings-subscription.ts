import type { SettingsEntry, SettingsKey, SettingsScope } from "@ace/protocol";
import type { ClientApi } from "./api.ts";

/** What a settings subscription needs from the connection. */
export type SettingsOwner = Pick<ClientApi, "state" | "connectionState" | "request" | "onMessage">;

/** Retry timers, injected so a failed read's backoff is testable without waiting. */
export interface RetryTimers {
  set(delay: number, run: () => void): () => void;
}

/**
 * Follow daemon settings: a `settings.subscribe` while connected, renewed after every reconnect,
 * then `settings.changed` pushes. A failed read retries with backoff while the connection stays
 * ready. `receive` gets every entry with `replace` on each fresh read, then the pushed changes.
 * `subscriptionId` must be unique on the socket; one subscription never stops another.
 */
export function subscribeSettings(
  client: SettingsOwner,
  subscriptionId: string,
  keys: readonly SettingsKey[],
  scope: SettingsScope,
  receive: (entries: readonly SettingsEntry[], replace: boolean) => void,
  failed: () => void,
  timers: RetryTimers,
) {
  let stopped = false;
  let subscribed = false;
  let generation = 0;
  let attempts = 0;
  let cancel: (() => void) | undefined;
  let pushed = new Map<SettingsKey, SettingsEntry>();
  const ask = () => {
    if (stopped || subscribed || client.state !== "ready" || !keys.length) return;
    subscribed = true;
    const current = ++generation;
    const changed = (pushed = new Map());
    void client
      .request({ type: "settings.subscribe", subscriptionId, keys: [...keys], scope })
      .then((reply) => {
        if (stopped || generation !== current) return;
        if (!reply.ok) throw new Error("Couldn't read settings");
        attempts = 0;
        receive(
          [...reply.entries.filter((entry) => !changed.has(entry.key)), ...changed.values()],
          true,
        );
      })
      .catch(() => {
        if (stopped || generation !== current) return;
        subscribed = false;
        failed();
        cancel = timers.set(Math.min(30_000, 1000 * 2 ** Math.min(attempts++, 5)), ask);
      });
  };
  const connection = client.connectionState();
  const stops = [
    client.onMessage((message) => {
      if (message.type === "settings.changed" && message.subscriptionId === subscriptionId) {
        for (const entry of message.entries) pushed.set(entry.key, entry);
        receive(message.entries, false);
      }
    }),
    connection.subscribe(() => {
      if (connection.getSnapshot() !== "ready") {
        subscribed = false;
        generation++;
        cancel?.();
      } else ask();
    }),
  ];
  ask();
  return {
    retry() {
      cancel?.();
      subscribed = false;
      ask();
    },
    stop() {
      stopped = true;
      cancel?.();
      for (const stop of stops) stop();
      if (client.state === "ready")
        void client.request({ type: "settings.unsubscribe", subscriptionId }).catch(() => {});
    },
  };
}
