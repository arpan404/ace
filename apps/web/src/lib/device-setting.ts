import { readJson, writeJson, type KeyValueStorage, type SafeParser } from "@ace/ui-core";
import { useCallback, useSyncExternalStore } from "react";
import { useLayout } from "./layout.tsx";

/*
 * A setting kept on this device (the layout's storage), shared live by every component that reads
 * it: whoever writes it, every reader updates together. A read returns the same value until the
 * stored text changes, so a list or object setting is a stable snapshot.
 */
const listeners = new WeakMap<KeyValueStorage, Map<string, Set<() => void>>>();
const cache = new WeakMap<KeyValueStorage, Map<string, { raw: string | null; value: unknown }>>();

function snapshot<T>(
  storage: KeyValueStorage | undefined,
  key: string,
  schema: SafeParser<T>,
  fallback: T,
): T {
  if (!storage) return fallback;
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    raw = null;
  }
  const byKey = cache.get(storage) ?? new Map();
  cache.set(storage, byKey);
  const held = byKey.get(key);
  // The cached value is only reused for the same text: a parse is never shared across keys' schemas.
  if (held && held.raw === raw) return held.value as T;
  const value = readJson(storage, key, schema, fallback);
  byKey.set(key, { raw, value });
  return value;
}

export function useDeviceSetting<T>(
  key: string,
  schema: SafeParser<T>,
  fallback: T,
): [T, (next: T) => void] {
  const { storage } = useLayout();
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!storage) return () => {};
      const byKey = listeners.get(storage) ?? new Map<string, Set<() => void>>();
      listeners.set(storage, byKey);
      const set = byKey.get(key) ?? new Set();
      byKey.set(key, set);
      set.add(listener);
      return () => void set.delete(listener);
    },
    [storage, key],
  );
  const read = () => snapshot(storage, key, schema, fallback);
  const value = useSyncExternalStore(subscribe, read, read);
  const set = useCallback(
    (next: T) => {
      writeJson(storage, key, next);
      if (storage) for (const listener of listeners.get(storage)?.get(key) ?? []) listener();
    },
    [storage, key],
  );
  return [value, set];
}
