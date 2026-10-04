import * as z from "zod/mini";
import { readJson, rememberRecent, writeJson, type KeyValueStorage } from "@ace/ui-core";
import { useCallback, useSyncExternalStore } from "react";
import { useLayout } from "@/lib/layout.tsx";

const Persisted = z.array(z.tuple([z.string(), z.array(z.string())]));
const none: readonly string[] = [];

/**
 * What each thread opened most recently (files, addresses), newest first, kept in this device's
 * storage: at most `perScope` entries for each of the `scopes` most recently used threads.
 */
export class ScopedRecent {
  private storage: KeyValueStorage | undefined;
  private key: string;
  private perScope: number;
  private scopes: number;
  private entries: ReadonlyMap<string, readonly string[]>;
  private listeners = new Set<() => void>();
  constructor(
    storage: KeyValueStorage | undefined,
    options: { key: string; perScope: number; scopes: number },
  ) {
    this.storage = storage;
    this.key = options.key;
    this.perScope = options.perScope;
    this.scopes = options.scopes;
    this.entries = new Map(readJson(storage, options.key, Persisted, []));
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  get(scope: string): readonly string[] {
    return this.entries.get(scope) ?? none;
  }
  remember(scope: string, value: string) {
    const current = this.get(scope);
    if (current[0] === value && this.entries.keys().next().value === scope) return;
    const next = [
      [scope, rememberRecent(current, value, this.perScope)] as const,
      ...[...this.entries].filter(([id]) => id !== scope),
    ];
    this.entries = new Map(next.slice(0, this.scopes));
    writeJson(this.storage, this.key, [...this.entries]);
    for (const listener of this.listeners) listener();
  }
}

const stores = new Map<string, WeakMap<object, ScopedRecent>>();
const unstored = new Map<string, ScopedRecent>();

/** The recent list named `key` for this app's storage, made once. */
export function useScopedRecentStore(options: {
  key: string;
  perScope: number;
  scopes: number;
}): ScopedRecent {
  const { storage } = useLayout();
  if (!storage) {
    let store = unstored.get(options.key);
    if (!store) {
      store = new ScopedRecent(undefined, options);
      unstored.set(options.key, store);
    }
    return store;
  }
  let byStorage = stores.get(options.key);
  if (!byStorage) {
    byStorage = new WeakMap();
    stores.set(options.key, byStorage);
  }
  let store = byStorage.get(storage);
  if (!store) {
    store = new ScopedRecent(storage, options);
    byStorage.set(storage, store);
  }
  return store;
}

/** A thread's recent list, live. */
export function useScopedRecent(store: ScopedRecent, scope: string): readonly string[] {
  const read = useCallback(() => store.get(scope), [store, scope]);
  return useSyncExternalStore(store.subscribe, read, read);
}
