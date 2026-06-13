import * as Schema from "effect/Schema";
import * as Record from "effect/Record";
import { useEffect, useReducer, useRef, useState } from "react";

const isomorphicLocalStorage: Storage =
  typeof window !== "undefined"
    ? window.localStorage
    : (function () {
        const store = new Map<string, string>();
        return {
          clear: () => store.clear(),
          getItem: (_) => store.get(_) ?? null,
          key: (_) => Record.keys(store).at(_) ?? null,
          get length() {
            return store.size;
          },
          removeItem: (_) => store.delete(_),
          setItem: (_, value) => store.set(_, value),
        };
      })();

const decode = <T, E>(schema: Schema.Codec<T, E>, value: string) =>
  Schema.decodeSync(Schema.fromJsonString(schema))(value);

const encode = <T, E>(schema: Schema.Codec<T, E>, value: T) =>
  Schema.encodeSync(Schema.fromJsonString(schema))(value);

export const getLocalStorageItem = <T, E>(key: string, schema: Schema.Codec<T, E>): T | null => {
  const item = isomorphicLocalStorage.getItem(key);
  return item ? decode(schema, item) : null;
};

export const setLocalStorageItem = <T, E>(key: string, value: T, schema: Schema.Codec<T, E>) => {
  const valueToSet = encode(schema, value);
  isomorphicLocalStorage.setItem(key, valueToSet);
};

export const removeLocalStorageItem = (key: string) => {
  isomorphicLocalStorage.removeItem(key);
};

const LOCAL_STORAGE_CHANGE_EVENT = "ace:local_storage_change";

interface LocalStorageChangeDetail {
  key: string;
  sourceId?: number;
}

type LocalStorageState<T> = {
  storageError: Error | null;
  storedValueState: { key: string; value: T };
};

type LocalStorageAction<T> =
  | { type: "sync"; key: string; value: T }
  | { type: "set-error"; value: Error | null };

let nextLocalStorageSourceId = 1;

function createLocalStorageSourceId() {
  return nextLocalStorageSourceId++;
}

export function resolveLocalStorageStoredValue<T>(
  state: { key: string; value: T },
  key: string,
  fallbackValue: T,
): T {
  return state.key === key ? state.value : fallbackValue;
}

function toLocalStorageError(key: string, operation: string, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`Failed to ${operation} localStorage key "${key}": ${detail}`);
}

function reportLocalStorageError(key: string, operation: string, error: unknown): Error {
  const normalized = toLocalStorageError(key, operation, error);
  console.error("[LOCALSTORAGE] Error:", normalized);
  return normalized;
}

function localStorageReducer<T>(
  state: LocalStorageState<T>,
  action: LocalStorageAction<T>,
): LocalStorageState<T> {
  switch (action.type) {
    case "sync":
      return {
        storageError: null,
        storedValueState: { key: action.key, value: action.value },
      };
    case "set-error":
      return {
        ...state,
        storageError: action.value,
      };
    default:
      return state;
  }
}

function dispatchLocalStorageChange(key: string, sourceId: number) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<LocalStorageChangeDetail>(LOCAL_STORAGE_CHANGE_EVENT, {
      detail: { key, sourceId },
    }),
  );
}

export function useLocalStorage<T, E>(
  key: string,
  initialValue: T,
  schema: Schema.Codec<T, E>,
): [T, (value: T | ((val: T) => T)) => void, Error | null] {
  let initialStorageError: Error | null = null;
  const initialStoredValue = (() => {
    try {
      const item = getLocalStorageItem(key, schema);
      return item ?? initialValue;
    } catch (error) {
      initialStorageError = reportLocalStorageError(key, "read", error);
      return initialValue;
    }
  })();

  const [state, dispatch] = useReducer(localStorageReducer<T>, {
    storageError: initialStorageError,
    storedValueState: {
      key,
      value: initialStoredValue,
    },
  });
  const { storageError, storedValueState } = state;
  const [sourceId] = useState(createLocalStorageSourceId);
  const storedValue = resolveLocalStorageStoredValue(storedValueState, key, initialStoredValue);

  // Return a wrapped version of useState's setter function that persists the new value to localStorage
  const setValue = (value: T | ((val: T) => T)) => {
    try {
      const previousValue = getLocalStorageItem(key, schema) ?? initialStoredValue;
      const valueToStore =
        typeof value === "function" ? (value as (val: T) => T)(previousValue) : value;
      if (Object.is(valueToStore, previousValue)) {
        if (storedValueState.key !== key) {
          dispatch({ type: "sync", key, value: previousValue });
        } else if (storageError !== null) {
          dispatch({ type: "set-error", value: null });
        }
        return;
      }
      if (valueToStore === null) {
        removeLocalStorageItem(key);
      } else {
        setLocalStorageItem(key, valueToStore, schema);
      }
      queueMicrotask(() => dispatchLocalStorageChange(key, sourceId));
      dispatch({ type: "sync", key, value: valueToStore });
    } catch (error) {
      dispatch({ type: "set-error", value: reportLocalStorageError(key, "write", error) });
    }
  };

  const prevKeyRef = useRef(key);

  // Re-sync from localStorage when key changes
  useEffect(() => {
    if (prevKeyRef.current !== key) {
      prevKeyRef.current = key;
      try {
        const newValue = getLocalStorageItem(key, schema);
        dispatch({ type: "sync", key, value: newValue ?? initialValue });
      } catch (error) {
        dispatch({ type: "set-error", value: reportLocalStorageError(key, "re-sync", error) });
      }
    }
  }, [key, initialValue, schema]);

  // Listen for storage events from other tabs AND custom events from the same tab
  useEffect(() => {
    const syncFromStorage = () => {
      try {
        const newValue = getLocalStorageItem(key, schema);
        dispatch({ type: "sync", key, value: newValue ?? initialValue });
      } catch (error) {
        dispatch({ type: "set-error", value: reportLocalStorageError(key, "sync", error) });
      }
    };

    const handleStorageChange = (event: StorageEvent) => {
      if (event.key === key) {
        syncFromStorage();
      }
    };

    const handleLocalChange = (event: CustomEvent<LocalStorageChangeDetail>) => {
      if (event.detail.key === key && event.detail.sourceId !== sourceId) {
        syncFromStorage();
      }
    };

    window.addEventListener("storage", handleStorageChange);
    window.addEventListener(LOCAL_STORAGE_CHANGE_EVENT, handleLocalChange as EventListener);

    return () => {
      window.removeEventListener("storage", handleStorageChange);
      window.removeEventListener(LOCAL_STORAGE_CHANGE_EVENT, handleLocalChange as EventListener);
    };
  }, [key, initialValue, schema]);

  return [storedValue, setValue, storageError];
}
