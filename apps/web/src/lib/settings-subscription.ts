import type { ClientApi } from "@ace/client";
import type { SettingsEntry, SettingsKey, SettingsScope } from "@ace/protocol";

/** Own a unique subscription across reconnects, including failed first reads. */
export function subscribeSettings(
  client: ClientApi,
  keys: readonly SettingsKey[],
  scope: SettingsScope,
  receive: (entries: readonly SettingsEntry[], replace: boolean) => void,
  failed: () => void,
  schedule: { set(delay: number, run: () => void): () => void } = {
    set(delay, run) {
      const timer = setTimeout(run, delay);
      return () => clearTimeout(timer);
    },
  },
) {
  const subscriptionId = `web-settings-${crypto.randomUUID()}`;
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
        cancel = schedule.set(Math.min(30_000, 1000 * 2 ** Math.min(attempts++, 5)), ask);
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
