import type { SidebarKey, SidebarReader, SidebarSource } from "@ace/client";
import type { ThreadListEntry } from "@ace/protocol";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useSidebarStore } from "./leases.ts";
import { arrayEqual, useSelection } from "./selection.ts";

export type { SidebarKey };

/** Select from the shared thread list with the same key and equality rules as useThread. */
export function useSidebar<T>(
  keys: readonly SidebarKey[],
  selector: (reader: SidebarReader) => T,
  equal?: (a: T, b: T) => boolean,
): T | undefined {
  const store = useSidebarStore();
  // Joined keys let callers pass a fresh array literal without re-subscribing.
  const keyList = keys.join("\u0000");
  const stableKeys = useMemo(() => keyList.split("\u0000") as SidebarKey[], [keyList]);
  const selection = useMemo(
    () => store?.select(stableKeys, selector, equal),
    [store, stableKeys, selector, equal],
  );
  return useSelection(selection);
}
const everything: readonly SidebarKey[] = ["ids", "threads"];
/**
 * Select over the whole thread list: re-runs when any entry or the membership changes, through
 * one key rather than one per thread, so it costs the same with ten threads or ten thousand.
 */
export function useSidebarAll<T>(
  selector: (reader: SidebarReader) => T,
  equal?: (a: T, b: T) => boolean,
): T | undefined {
  return useSidebar(everything, selector, equal);
}
const readIds = (reader: SidebarReader) => reader.ids;
export function useSidebarIds(): readonly string[] | undefined {
  return useSidebar(["ids"], readIds, arrayEqual);
}
const readLoaded = (reader: SidebarReader) => reader.loaded;
/** False until the thread list's first snapshot, so screens can show a skeleton, not "empty". */
export function useSidebarLoaded(): boolean {
  return useSidebar(["ids"], readLoaded) ?? false;
}
export function useSidebarThread(threadId: string) {
  const selector = useCallback((reader: SidebarReader) => reader.thread(threadId), [threadId]);
  return useSidebar([`thread:${threadId}`], selector);
}

/**
 * A view over the thread list kept from the changed entries alone: `pick` runs for every entry
 * on a new snapshot, then only for the entries a change names. Entries it maps to undefined are
 * left out; the rest are kept in the order they were first picked (list order for a snapshot).
 * The array keeps its identity until a picked value changes by `equal`.
 */
class SidebarIndex<T> {
  private rows = new Map<string, T>();
  private snapshot: readonly T[] | undefined;
  private listeners = new Set<() => void>();
  private stop: (() => void) | undefined;
  private readonly store: SidebarSource;
  private readonly pick: (entry: ThreadListEntry) => T | undefined;
  private readonly equal: (a: T, b: T) => boolean;
  constructor(
    store: SidebarSource,
    pick: (entry: ThreadListEntry) => T | undefined,
    equal: (a: T, b: T) => boolean,
  ) {
    this.store = store;
    this.pick = pick;
    this.equal = equal;
  }
  get = (): readonly T[] | undefined => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    if (!this.listeners.size) {
      this.stop = this.store.observe((keys) => this.update(keys));
      this.update("all");
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size) return;
      this.stop?.();
      this.stop = undefined;
    };
  };
  private value(id: string): T | undefined {
    const entry = this.store.thread(id);
    return entry && this.pick(entry);
  }
  private update(keys: ReadonlySet<string> | "all"): void {
    if (!this.store.loaded) return;
    let changed = this.snapshot === undefined;
    if (keys === "all") {
      const rows = new Map<string, T>();
      for (const id of this.store.ids) {
        const value = this.value(id);
        if (value === undefined) continue;
        const before = this.rows.get(id);
        rows.set(id, before !== undefined && this.equal(before, value) ? before : value);
      }
      changed ||=
        rows.size !== this.rows.size || [...rows].some(([id, row]) => this.rows.get(id) !== row);
      this.rows = rows;
    } else
      for (const key of keys) {
        if (!key.startsWith("thread:")) continue;
        const id = key.slice(7);
        const value = this.value(id);
        const before = this.rows.get(id);
        if (value === undefined) changed = this.rows.delete(id) || changed;
        else if (before === undefined || !this.equal(before, value)) {
          this.rows.set(id, value);
          changed = true;
        }
      }
    if (!changed) return;
    this.snapshot = [...this.rows.values()];
    for (const listener of this.listeners) listener();
  }
}

const noIndex = { subscribe: () => () => {}, get: () => undefined };

/**
 * The thread list through `pick`, updated from the changed entries alone, so a view over a few
 * threads of a long list costs little per change. Undefined until the list has loaded. Keep
 * `pick` and `equal` stable: a new one rebuilds the index.
 */
export function useSidebarIndex<T>(
  pick: (entry: ThreadListEntry) => T | undefined,
  equal: (a: T, b: T) => boolean = Object.is,
): readonly T[] | undefined {
  const store = useSidebarStore();
  const index = useMemo(
    () => (store ? new SidebarIndex(store, pick, equal) : noIndex),
    [store, pick, equal],
  );
  return useSyncExternalStore(index.subscribe, index.get, index.get);
}
