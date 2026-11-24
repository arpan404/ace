import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { SpadeEndpoint } from "@ace/ui-core/spade-chat";

/*
 * Spade's starred models, kept on this device. One browser-wide key holds every machine's stars,
 * because two machines can call an endpoint the same thing; each record also names the account
 * when the endpoint has one (a ChatGPT sign-in). Every picker reads the same store, so a star
 * placed in one picker shows in the next.
 */
const storageKey = "ace.spade.models.favorites";

export interface SpadeFavorite {
  machine: string;
  account: string;
  value: string;
}

let cache: SpadeFavorite[] | undefined;
const listeners = new Set<() => void>();
let watchingStorage = false;

function isStoredFavorite(value: unknown): value is SpadeFavorite {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.machine === "string" &&
    typeof record.account === "string" &&
    typeof record.value === "string"
  );
}

function read(): SpadeFavorite[] {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isStoredFavorite) : [];
  } catch {
    return [];
  }
}

function emit(): void {
  for (const listener of listeners) listener();
}

function remember(next: SpadeFavorite[]): void {
  cache = next;
  try {
    localStorage.setItem(storageKey, JSON.stringify(next));
  } catch {
    // Ignore storage quota or private-mode errors: the picker still works for this page.
  }
  emit();
}

function snapshot(): SpadeFavorite[] {
  cache ??= read();
  return cache;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!watchingStorage && typeof window !== "undefined") {
    watchingStorage = true;
    window.addEventListener("storage", onStorage);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size && watchingStorage) {
      watchingStorage = false;
      window.removeEventListener("storage", onStorage);
    }
  };
}

function onStorage(event: StorageEvent): void {
  if (event.key !== storageKey) return;
  cache = read();
  emit();
}

/** A favorite's identity: the machine, the account it signs in as, and the endpoint/model. */
export function favoriteId(machine: string, account: string, value: string): string {
  return JSON.stringify([machine, account, value]);
}

/** The account a stored model belongs to, when it has one beyond its endpoint id. */
export function favoriteAccount(endpoint: SpadeEndpoint | undefined): string {
  return endpoint?.account?.email ?? "";
}

/**
 * Stars for one machine, shared by every picker on the page. `isFavorite` and `toggle` take the
 * option's account, so the same endpoint slug on two machines or two sign-ins stays separate.
 */
export function useSpadeFavorites(machine: string) {
  const all = useSyncExternalStore(subscribe, snapshot, snapshot);
  const scoped = useMemo(
    () => all.filter((favorite) => favorite.machine === machine),
    [all, machine],
  );
  const ids = useMemo(
    () => new Set(scoped.map((favorite) => favoriteId(machine, favorite.account, favorite.value))),
    [scoped, machine],
  );
  const values = useMemo(() => [...new Set(scoped.map((favorite) => favorite.value))], [scoped]);
  const isFavorite = useCallback(
    (account: string, value: string) => ids.has(favoriteId(machine, account, value)),
    [ids, machine],
  );
  const toggle = useCallback(
    (account: string, value: string) => {
      const id = favoriteId(machine, account, value);
      const existing = snapshot();
      const has = existing.some(
        (favorite) => favoriteId(favorite.machine, favorite.account, favorite.value) === id,
      );
      remember(
        has
          ? existing.filter(
              (favorite) => favoriteId(favorite.machine, favorite.account, favorite.value) !== id,
            )
          : [{ machine, account, value }, ...existing],
      );
    },
    [machine],
  );
  return { values, isFavorite, toggle };
}
