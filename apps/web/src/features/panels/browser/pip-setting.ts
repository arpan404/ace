import * as z from "zod/mini";
import { readJson, writeJson, type KeyValueStorage } from "@ace/ui-core";
import { useSyncExternalStore } from "react";
import { useLayout } from "@/lib/layout.tsx";

const key = "ace.browser.pip.automatic";

/**
 * Whether a thread's page floats in picture-in-picture by itself when the person leaves its
 * Browser while an agent browses or the page plays sound. On unless turned off. Local to the
 * device: it is how this screen follows a page, not what the page is.
 */
class PipSetting {
  private storage: KeyValueStorage | undefined;
  private value: boolean;
  private listeners = new Set<() => void>();
  constructor(storage: KeyValueStorage | undefined) {
    this.storage = storage;
    this.value = readJson(storage, key, z.boolean(), true);
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  automatic = (): boolean => this.value;
  set(value: boolean): void {
    this.value = value;
    writeJson(this.storage, key, value);
    for (const listener of this.listeners) listener();
  }
}

const stores = new WeakMap<object, PipSetting>();
let unstored: PipSetting | undefined;

function usePipSetting(): PipSetting {
  const { storage } = useLayout();
  if (!storage) return (unstored ??= new PipSetting(undefined));
  let store = stores.get(storage);
  if (!store) {
    store = new PipSetting(storage);
    stores.set(storage, store);
  }
  return store;
}

/** "Picture in picture" (Settings › Browser), kept current. */
export function useAutomaticPip(): [boolean, (value: boolean) => void] {
  const store = usePipSetting();
  const automatic = useSyncExternalStore(store.subscribe, store.automatic);
  return [automatic, (value) => store.set(value)];
}
