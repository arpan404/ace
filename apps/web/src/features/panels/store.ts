import { useCallback, useSyncExternalStore } from "react";

/**
 * Client-only panel state that must outlive the tab showing it (tab content unmounts when
 * another tab is picked): draft review comments, diff view preferences, log cut-offs. Never
 * daemon state; that lives in `@ace/client` stores.
 */
export class LocalStore<T> {
  private value: T;
  private listeners = new Set<() => void>();
  constructor(initial: T) {
    this.value = initial;
  }
  get = (): T => this.value;
  set(next: (previous: T) => T): void {
    this.value = next(this.value);
    for (const listener of this.listeners) listener();
  }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

/** Follow an external source's version counter (sources need not bind their methods). */
export function useVersion(source: {
  subscribe(listener: () => void): () => void;
  readonly version: number;
}): number {
  const subscribe = useCallback((listener: () => void) => source.subscribe(listener), [source]);
  const read = useCallback(() => source.version, [source]);
  return useSyncExternalStore(subscribe, read, read);
}

/** Select from a LocalStore; `select` must return a stable value for unchanged state. */
export function useLocal<T, R>(store: LocalStore<T>, select: (value: T) => R): R {
  const read = useCallback(() => select(store.get()), [store, select]);
  return useSyncExternalStore(store.subscribe, read, read);
}
