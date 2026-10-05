import type { ClientApi } from "@ace/client";
import { useClient } from "@ace/client-react";
import { useSyncExternalStore } from "react";
import * as z from "zod/mini";

// zod/mini names `.default()` `_default` (`default` is a reserved word as a binding).
// oxlint-disable-next-line no-underscore-dangle
const withDefault = z._default;
import { readJson, writeJson, type KeyValueStorage } from "@ace/ui-core";

/**
 * In-app toast preferences for this device. They decide which live changes surface as a
 * toast; push delivery and quiet hours are the daemon's (`notification.preferences`, ADR 0012)
 * and belong to Settings › Notifications.
 */
export const NotificationPrefs = z.object({
  /** A thread starts waiting on an approval, a question or a plan review. */
  needsYou: withDefault(z.boolean(), true),
  /** A thread fails. */
  failures: withDefault(z.boolean(), true),
  /** An automation run finishes. */
  automations: withDefault(z.boolean(), true),
  /** An account nears or reaches a usage limit, or can work again after one. */
  limits: withDefault(z.boolean(), true),
});
export type NotificationPrefs = z.infer<typeof NotificationPrefs>;

const defaults: NotificationPrefs = {
  needsYou: true,
  failures: true,
  automations: true,
  limits: true,
};
const storageKey = "ace.notifications.toasts";

export interface PrefsStore {
  get(): NotificationPrefs;
  set(patch: Partial<NotificationPrefs>): void;
  subscribe(listener: () => void): () => void;
}

export function prefsStore(storage: KeyValueStorage | undefined): PrefsStore {
  let value = readJson(storage, storageKey, NotificationPrefs, defaults);
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(patch) {
      value = { ...value, ...patch };
      writeJson(storage, storageKey, value);
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

// One store per daemon client over this window's localStorage: device-wide values, but a fresh
// in-memory copy whenever the app reconnects (and in every test).
const stores = new WeakMap<ClientApi, PrefsStore>();

export function useNotificationPrefs(): [
  NotificationPrefs,
  (patch: Partial<NotificationPrefs>) => void,
] {
  const client = useClient();
  let prefs = stores.get(client);
  if (!prefs) {
    prefs = prefsStore(typeof localStorage === "undefined" ? undefined : localStorage);
    stores.set(client, prefs);
  }
  const value = useSyncExternalStore(prefs.subscribe, prefs.get, prefs.get);
  return [value, prefs.set];
}
