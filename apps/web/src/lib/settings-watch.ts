import { subscribeSettings } from "./settings-subscription.ts";
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

/** Settings consumers share the subscription owner and its stale-reply fence. */
export function watchSettings(
  client: ClientApi,
  keys: SettingsKey[],
  scope: SettingsScope,
  apply: (entries: readonly SettingsEntry[]) => void,
  schedule: RetryTimers = timers,
): () => void {
  return subscribeSettings(client, keys, scope, apply, () => {}, schedule).stop;
}
