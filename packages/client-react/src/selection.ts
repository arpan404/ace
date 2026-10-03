import type { Selection } from "@ace/client";
import { useSyncExternalStore } from "react";

const noop = () => {};
const unloaded: Selection<undefined> = {
  getSnapshot: () => undefined,
  subscribe: () => noop,
};

/** Read a client Selection. Undefined while its store is not leased yet. */
export function useSelection<T>(selection: Selection<T> | undefined): T | undefined {
  const source: Selection<T | undefined> = selection ?? unloaded;
  return useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
}

export function arrayEqual<T>(a: readonly T[] | undefined, b: readonly T[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}
export function shallowEqual<T extends object>(a: T | undefined, b: T | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys)
    if (!Object.hasOwn(b, key) || !Object.is(a[key as keyof T], b[key as keyof T])) return false;
  return true;
}
