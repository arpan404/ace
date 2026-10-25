import { subscribeSettings as follow, type ClientApi, type RetryTimers } from "@ace/client";
import type { SettingsEntry, SettingsKey, SettingsScope } from "@ace/protocol";

const timers: RetryTimers = {
  set(delay, run) {
    const timer = setTimeout(run, delay);
    return () => clearTimeout(timer);
  },
};

/** Own a unique subscription across reconnects, including failed first reads. */
export function subscribeSettings(
  client: ClientApi,
  keys: readonly SettingsKey[],
  scope: SettingsScope,
  receive: (entries: readonly SettingsEntry[], replace: boolean) => void,
  failed: () => void,
  schedule: RetryTimers = timers,
) {
  return follow(
    client,
    `web-settings-${crypto.randomUUID()}`,
    keys,
    scope,
    receive,
    failed,
    schedule,
  );
}
