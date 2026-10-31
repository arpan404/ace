import { HomeFocus, readJson, writeJson, type KeyValueStorage } from "@ace/ui-core";
import { useCallback, useSyncExternalStore } from "react";
import { useLayoutServices, type SessionKey } from "@/lib/layout.tsx";

/*
 * Which focused list the Threads panel shows (a place, or one project's tab), or none for the
 * tree. Per window: kept in the window's own storage, so a reload comes back to it while another
 * window keeps its own.
 */

const storageKey = "ace.home.focus";
const Stored = HomeFocus.nullable().catch(null);

class FocusStore {
  private value: HomeFocus | null;
  private listeners = new Set<() => void>();
  private storage: KeyValueStorage | undefined;
  constructor(storage: KeyValueStorage | undefined) {
    this.storage = storage;
    this.value = readJson(storage, storageKey, Stored, null);
  }
  get = (): HomeFocus | null => this.value;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  set(value: HomeFocus | null): void {
    this.value = value;
    writeJson(this.storage, storageKey, value);
    for (const listener of this.listeners) listener();
  }
}

const focusKey: SessionKey<FocusStore> = { name: "home-focus" };

/** The panel's focused list and a way to change it (null goes back to the tree). */
export function useHomeFocus(): [HomeFocus | null, (focus: HomeFocus | null) => void] {
  const services = useLayoutServices();
  const store = services.sessionValue(focusKey, () => new FocusStore(services.windowStorage));
  const focus = useSyncExternalStore(store.subscribe, store.get, store.get);
  const set = useCallback((next: HomeFocus | null) => store.set(next), [store]);
  return [focus, set];
}
