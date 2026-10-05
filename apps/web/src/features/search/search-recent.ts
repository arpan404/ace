import { useCallback, useSyncExternalStore } from "react";

/*
 * Recent searches on this device: the last eight, newest first, in localStorage
 * (`ace.search.recent`). The empty Search page offers them; a row's ✕ forgets one.
 */
const storageKey = "ace.search.recent";
const keep = 8;
const listeners = new Set<() => void>();
let cached: { raw: string | null; list: readonly string[] } | undefined;

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** The stored list; the same array while storage holds the same text. */
function read(): readonly string[] {
  let raw: string | null = null;
  try {
    raw = storage()?.getItem(storageKey) ?? null;
  } catch {
    raw = null;
  }
  if (cached && cached.raw === raw) return cached.list;
  let list: readonly string[] = [];
  try {
    const parsed: unknown = JSON.parse(raw ?? "[]");
    if (Array.isArray(parsed))
      list = parsed.filter((entry): entry is string => typeof entry === "string").slice(0, keep);
  } catch {
    list = [];
  }
  cached = { raw, list };
  return list;
}

function write(next: readonly string[]) {
  try {
    storage()?.setItem(storageKey, JSON.stringify(next));
  } catch {
    // Private mode or a full quota: recent searches just aren't kept.
  }
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export function useRecentSearches() {
  const recent = useSyncExternalStore(subscribe, read, read);
  const remember = useCallback((query: string) => {
    const text = query.trim();
    if (!text) return;
    write([text, ...read().filter((entry) => entry !== text)].slice(0, keep));
  }, []);
  const forget = useCallback(
    (query: string) => write(read().filter((entry) => entry !== query)),
    [],
  );
  return { recent, remember, forget };
}
