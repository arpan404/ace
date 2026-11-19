import { createContext, use, useCallback, useMemo, useState, useSyncExternalStore } from "react";

/** One log's disclosures, kept by id when streaming steps regroup. */
interface OpenSteps {
  get(id: string): boolean | undefined;
  set(id: string, open: boolean): void;
  subscribe(ids: readonly string[], changed: () => void): () => void;
}

function createOpenSteps(): OpenSteps {
  const open = new Map<string, boolean>();
  const listeners = new Map<string, Set<() => void>>();
  return {
    get: (id) => open.get(id),
    set(id, value) {
      if (open.get(id) === value) return;
      open.set(id, value);
      for (const changed of listeners.get(id) ?? []) changed();
    },
    subscribe(ids, changed) {
      const keys = new Set(ids);
      for (const id of keys) {
        let readers = listeners.get(id);
        if (!readers) listeners.set(id, (readers = new Set()));
        readers.add(changed);
      }
      return () => {
        for (const id of keys) {
          const readers = listeners.get(id);
          readers?.delete(changed);
          if (!readers?.size) listeners.delete(id);
        }
      };
    },
  };
}

export const OpenStepsContext = createContext<OpenSteps | undefined>(undefined);

/** A stable store: toggling a disclosure only wakes readers of that id. */
export function useOpenSteps(): OpenSteps {
  return useState(createOpenSteps)[0];
}

/** Whether the reader opened a step, undefined until they toggle it. */
export function useStepOpen(itemId: string): [boolean | undefined, (open: boolean) => void] {
  const store = use(OpenStepsContext);
  const [local, setLocal] = useState<boolean>();
  const key = `step:${itemId}`;
  const subscribe = useCallback(
    (changed: () => void) => store?.subscribe([key], changed) ?? (() => {}),
    [store, key],
  );
  const read = useCallback(() => (store ? store.get(key) : local), [store, key, local]);
  const open = useSyncExternalStore(subscribe, read, read);
  return [open, (value) => (store ? store.set(key, value) : setLocal(value))];
}

/** A group follows its opened children until the reader explicitly toggles it. */
export function useGroupOpen(
  key: string,
  ids: readonly string[],
): [boolean, (open: boolean) => void] {
  const store = use(OpenStepsContext);
  const [local, setLocal] = useState(false);
  const group = `group:${key}`;
  const steps = useMemo(() => ids.map((id) => `step:${id}`), [ids]);
  const subscribe = useCallback(
    (changed: () => void) => store?.subscribe([group, ...steps], changed) ?? (() => {}),
    [store, group, steps],
  );
  const read = useCallback(
    () => (store ? (store.get(group) ?? steps.some((id) => store.get(id) === true)) : local),
    [store, group, steps, local],
  );
  const open = useSyncExternalStore(subscribe, read, read);
  return [open, (value) => (store ? store.set(group, value) : setLocal(value))];
}
