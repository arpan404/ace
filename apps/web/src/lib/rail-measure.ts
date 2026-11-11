import { RailMeasure, readJson, writeJson, type KeyValueStorage } from "@ace/ui-core";
import { useCallback, useSyncExternalStore } from "react";
import { useLayout } from "./layout.tsx";

/*
 * What the rail's Usage bars show on this device: each account's week (the default) or its
 * session. Settings › General sets it; the rail reads it, and both update together.
 */
const key = "ace.usage.railMeasure";
const listeners = new WeakMap<KeyValueStorage, Set<() => void>>();

function railMeasure(storage: KeyValueStorage | undefined): RailMeasure {
  return readJson(storage, key, RailMeasure, "week");
}

export function useRailMeasure(): [RailMeasure, (measure: RailMeasure) => void] {
  const { storage } = useLayout();
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!storage) return () => {};
      const set = listeners.get(storage) ?? new Set();
      listeners.set(storage, set);
      set.add(listener);
      return () => void set.delete(listener);
    },
    [storage],
  );
  const read = () => railMeasure(storage);
  const measure = useSyncExternalStore(subscribe, read, read);
  const set = useCallback(
    (next: RailMeasure) => {
      writeJson(storage, key, next);
      if (storage) for (const listener of listeners.get(storage) ?? []) listener();
    },
    [storage],
  );
  return [measure, set];
}
