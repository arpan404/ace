import type { KeyValueStorage } from "@ace/ui-core";
import { webStorage } from "./web-storage.ts";

/** Where a window keeps its ace account session: `ace.account.session:<origin>`. */
const accountSession = (key: string) => key.startsWith("ace.account.session:");

/**
 * The window's session storage, except that its ace account session stays in this window's
 * memory (ADR 0190): never written to `sessionStorage`, which the browser keeps on disk for
 * session restore, where any process of the same user could read it. A copy an older build left
 * there is removed. The desktop app restores the session from its secure store when the window
 * opens; a browser tab signs in again after a reload.
 */
export function accountSessionsInMemory(base: KeyValueStorage, raw?: Storage): KeyValueStorage {
  const held = new Map<string, string>();
  try {
    if (raw) for (const key of Object.keys(raw)) if (accountSession(key)) raw.removeItem(key);
  } catch {
    // A browser that denies storage holds nothing there to remove.
  }
  return {
    ...(base.durable === undefined ? {} : { durable: base.durable }),
    getItem: (key) => (accountSession(key) ? (held.get(key) ?? null) : base.getItem(key)),
    setItem: (key, value) => {
      if (accountSession(key)) held.set(key, value);
      else base.setItem(key, value);
    },
    removeItem: (key) => {
      if (accountSession(key)) held.delete(key);
      else base.removeItem?.(key);
    },
  };
}

let shared: KeyValueStorage | undefined;

/** This window's one session storage, shared by everything that reads its ace session. */
export function windowSessionStorage(): KeyValueStorage {
  if (shared) return shared;
  let raw: Storage | undefined;
  try {
    raw = sessionStorage;
  } catch {
    raw = undefined;
  }
  shared = accountSessionsInMemory(
    webStorage(() => sessionStorage),
    raw,
  );
  return shared;
}
