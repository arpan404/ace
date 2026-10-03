import type { SettingsValuesMap, ValuesStore } from "./backend.ts";

/** An in-memory settings map with change notification, shared by the interim backends. */
export function memoryValues(initial: SettingsValuesMap): ValuesStore & {
  set(key: string, value: unknown): void;
  replace(next: SettingsValuesMap): void;
} {
  let values = initial;
  const listeners = new Set<() => void>();
  const replace = (next: SettingsValuesMap) => {
    values = next;
    for (const listener of listeners) listener();
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    get: () => values,
    set: (key, value) => replace({ ...values, [key]: value }),
    replace,
  };
}
