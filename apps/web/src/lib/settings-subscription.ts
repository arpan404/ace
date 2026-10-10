import type { ClientApi } from "@ace/client";
import type { SettingsEntry, SettingsKey, SettingsScope } from "@ace/protocol";

/** Own a unique subscription across reconnects, including failed first reads. */
export function subscribeSettings(
  client: ClientApi,
  keys: readonly SettingsKey[],
  scope: SettingsScope,
  receive: (entries: readonly SettingsEntry[], replace: boolean) => void,
  failed: () => void,
) {
  const subscriptionId = `web-settings-${crypto.randomUUID()}`;
  let stopped = false;
  let subscribed = false;
  let generation = 0;
  let attempts = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ask = () => {
    if (stopped || subscribed || client.state !== "ready" || !keys.length) return;
    subscribed = true;
    const current = ++generation;
    void client
      .request({ type: "settings.subscribe", subscriptionId, keys: [...keys], scope })
      .then((reply) => {
        if (stopped || generation !== current) return;
        attempts = 0;
        receive(reply.entries, true);
      })
      .catch(() => {
        if (stopped || generation !== current) return;
        subscribed = false;
        failed();
        timer = setTimeout(ask, Math.min(30_000, 1000 * 2 ** Math.min(attempts++, 5)));
      });
  };
  const connection = client.connectionState();
  const stops = [
    client.onMessage((message) => {
      if (message.type === "settings.changed" && message.subscriptionId === subscriptionId)
        receive(message.entries, false);
    }),
    connection.subscribe(() => {
      if (connection.getSnapshot() !== "ready") {
        subscribed = false;
        generation++;
        clearTimeout(timer);
      } else ask();
    }),
  ];
  ask();
  return {
    retry() {
      clearTimeout(timer);
      subscribed = false;
      ask();
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      for (const stop of stops) stop();
      if (client.state === "ready")
        void client.request({ type: "settings.unsubscribe", subscriptionId }).catch(() => {});
    },
  };
}
