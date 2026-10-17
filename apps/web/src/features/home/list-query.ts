import type { KeyValueStorage } from "@ace/ui-core";
import { useSyncExternalStore } from "react";
import { useLayout } from "@/lib/layout.tsx";

/** What Search reads of a thread. */
export interface Searchable {
  title: string;
  workspaceId: string;
  details?: { branch?: string | null | undefined } | undefined;
}

/**
 * What the sidebar's Search field narrows the thread list to: words matched, case-insensitively,
 * against a thread's title, its project's name and its branch. Not kept: a reload starts clear.
 */
export function matchesListQuery(
  entry: Searchable,
  query: string,
  projectName: (id: string) => string,
): boolean {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return true;
  const fields = [entry.title, projectName(entry.workspaceId), entry.details?.branch ?? ""];
  return fields.some((field) => field.toLowerCase().includes(wanted));
}

/** `entries` the query lets through, the same array when there is no query. */
export function filterByQuery<T extends Searchable>(
  entries: T[],
  query: string,
  projectName: (id: string) => string,
): T[] {
  if (!query.trim()) return entries;
  return entries.filter((entry) => matchesListQuery(entry, query, projectName));
}

export interface ListQuery {
  get(): string;
  set(query: string): void;
  subscribe(listener: () => void): () => void;
}

function createListQuery(): ListQuery {
  let query = "";
  const listeners = new Set<() => void>();
  return {
    get: () => query,
    set: (next) => {
      if (next === query) return;
      query = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

// One per injected storage, so each app instance (and each test) has its own, as the organizer.
const queries = new WeakMap<KeyValueStorage, ListQuery>();
let unstored: ListQuery | undefined;

function listQueryFor(storage: KeyValueStorage | undefined): ListQuery {
  if (!storage) return (unstored ??= createListQuery());
  let found = queries.get(storage);
  if (!found) {
    found = createListQuery();
    queries.set(storage, found);
  }
  return found;
}

export function useListQueryStore(): ListQuery {
  return listQueryFor(useLayout().storage);
}

/** The Search field's words now. */
export function useListQuery(): string {
  const store = useListQueryStore();
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
