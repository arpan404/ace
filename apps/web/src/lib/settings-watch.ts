import type { ClientApi } from "@ace/client";
import type { SettingsEntry, SettingsKey, SettingsScope } from "@ace/protocol";

let prefix: string | undefined;
let next = 0;
/** Each tab shares a socket, but owns its subscriptions. */
export function settingsSubscriptionId(): string {
  prefix ??= crypto.randomUUID();
  return `settings-${prefix}-${++next}`;
}

export interface RetryTimers {
  set(delay: number, run: () => void): () => void;
}
const timers: RetryTimers = {
  set(delay, run) {
    const timer = setTimeout(run, delay);
    return () => clearTimeout(timer);
  },
};

/** Renew on reconnect and retry refused reads while connected; stale replies never win. */
export function watchSettings(
  client: ClientApi,
  keys: SettingsKey[],
  scope: SettingsScope,
  apply: (entries: readonly SettingsEntry[]) => void,
  schedule: RetryTimers = timers,
): () => void {
  const subscriptionId = settingsSubscriptionId();
  let stopped = false;
  let epoch = 0;
  let subscribed = false;
  let attempts = 0;
  let cancel: (() => void) | undefined;
  let pushed = new Set<SettingsKey>();
  const ask = () => {
    if (stopped || subscribed || client.state !== "ready" || !keys.length) return;
    subscribed = true;
    const current = epoch;
    pushed = new Set();
    const changed = pushed;
    void client
      .request({ type: "settings.subscribe", subscriptionId, keys, scope })
      .then((reply) => {
        if (stopped || current !== epoch) return;
        if (!reply.ok) throw new Error("Couldn't read settings");
        attempts = 0;
        apply(reply.entries.filter((entry) => !changed.has(entry.key)));
      })
      .catch(() => {
        if (stopped || current !== epoch) return;
        subscribed = false;
        cancel = schedule.set(Math.min(30_000, 1000 * 2 ** Math.min(attempts++, 5)), () => {
          cancel = undefined;
          ask();
        });
      });
  };
  const stops = [
    client.onMessage((message) => {
      if (message.type === "settings.changed" && message.subscriptionId === subscriptionId) {
        for (const entry of message.entries) pushed.add(entry.key);
        apply(message.entries);
      }
    }),
    client.connectionState().subscribe(() => {
      epoch++;
      cancel?.();
      cancel = undefined;
      subscribed = false;
      attempts = 0;
      ask();
    }),
  ];
  ask();
  return () => {
    stopped = true;
    epoch++;
    cancel?.();
    for (const stop of stops) stop();
    if (client.state === "ready")
      void client.request({ type: "settings.unsubscribe", subscriptionId }).catch(() => {});
  };
}
