import type { KeyValueStorage } from "@ace/ui-core";
import { webStorage } from "./web-storage.ts";

let store: KeyValueStorage | undefined;

/**
 * This browser's device id, created once and kept in localStorage. Where the browser denies
 * storage it lasts for this page only, so ace still starts.
 */
export function deviceId(): string {
  store ??= webStorage(() => localStorage);
  const key = "ace.deviceId";
  const existing = store.getItem(key);
  if (existing) return existing;
  const created = `web-${crypto.randomUUID()}`;
  store.setItem(key, created);
  return created;
}
