import * as z from "zod/mini";
import { readJson, writeJson, type KeyValueStorage } from "@ace/ui-core";
import { useSyncExternalStore } from "react";
import { useLayout } from "@/lib/layout.tsx";

/**
 * One on/off choice kept on this device (Settings › Browser › This device): how this screen
 * follows a thread's browser, never what the browser is. Each storage holds one store per key,
 * so every view of a choice reads and changes the same value.
 */
class DeviceToggle {
  private storage: KeyValueStorage | undefined;
  private key: string;
  private value: boolean;
  private listeners = new Set<() => void>();
  constructor(storage: KeyValueStorage | undefined, key: string, fallback: boolean) {
    this.storage = storage;
    this.key = key;
    this.value = readJson(storage, key, z.boolean(), fallback);
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  read = (): boolean => this.value;
  set(value: boolean): void {
    this.value = value;
    writeJson(this.storage, this.key, value);
    for (const listener of this.listeners) listener();
  }
}

const stored = new WeakMap<object, Map<string, DeviceToggle>>();
const unstored = new Map<string, DeviceToggle>();

function useToggleStore(key: string, fallback: boolean): DeviceToggle {
  const { storage } = useLayout();
  let byKey = storage ? stored.get(storage) : unstored;
  if (!byKey) {
    byKey = new Map();
    if (storage) stored.set(storage, byKey);
  }
  let store = byKey.get(key);
  if (!store) {
    store = new DeviceToggle(storage, key, fallback);
    byKey.set(key, store);
  }
  return store;
}

/** The device choice stored under `key` (`fallback` until the person picks), kept current. */
export function useDeviceToggle(
  key: string,
  fallback: boolean,
): [boolean, (value: boolean) => void] {
  const store = useToggleStore(key, fallback);
  const value = useSyncExternalStore(store.subscribe, store.read);
  return [value, (next) => store.set(next)];
}
