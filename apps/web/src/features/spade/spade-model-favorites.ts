import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { SpadeEndpoint } from "@ace/ui-core/spade-chat";

/*
 * Spade's starred models, kept on this device. One browser-wide key holds every machine's stars,
 * because two machines can call an endpoint the same thing; each record also names the account
 * when the endpoint has one (a ChatGPT sign-in). Every picker reads the same store, so a star
 * placed in one picker shows in the next.
 *
 * The old picker stored plain `endpoint/model` strings under this key. They are still read (and
 * shown for the machine doing the reading), then written back as records the first time this
 * machine writes; a string whose endpoint can't be read stays as it was.
 */
const storageKey = "ace.spade.models.favorites";

export interface SpadeFavorite {
  machine: string;
  account: string;
  value: string;
}

/** A record, or a legacy `endpoint/model` string this store hasn't resolved yet. */
type StoredFavorite = SpadeFavorite | string;

let cache: StoredFavorite[] | undefined;
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

function readRaw(): string | null {
  try {
    return localStorage.getItem(storageKey);
  } catch {
    return null;
  }
}

function parse(raw: string | null): StoredFavorite[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is StoredFavorite =>
        isStoredFavorite(item) || (typeof item === "string" && item.trim() !== ""),
    );
  } catch {
    return [];
  }
}

function readFresh(): StoredFavorite[] {
  return parse(readRaw());
}

function emit(): void {
  for (const listener of listeners) listener();
}

function write(next: StoredFavorite[]): void {
  cache = next;
  try {
    localStorage.setItem(storageKey, JSON.stringify(next));
  } catch {
    // Ignore storage quota or private-mode errors: the picker still works for this page.
  }
  emit();
}

function snapshot(): StoredFavorite[] {
  cache ??= readFresh();
  return cache;
}

function subscribe(listener: () => void): () => void {
  // The last picker left a cached view; a reopened one reads what storage holds now.
  cache = readFresh();
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
  cache = readFresh();
  emit();
}

/** A favorite's identity: the machine, the endpoint (account) id, and the endpoint/model. */
export function favoriteId(machine: string, account: string, value: string): string {
  return JSON.stringify([machine, account, value]);
}

/** The stable account an endpoint is: its id, never the name or email a sign-in may change. */
export function favoriteAccount(endpoint: SpadeEndpoint | undefined): string {
  return endpoint?.id ?? "";
}

/** A legacy `endpoint/model` string as a record for this machine, when it names an endpoint. */
function resolveLegacy(value: string, machine: string): SpadeFavorite | undefined {
  const slash = value.indexOf("/");
  const account = slash > 0 ? value.slice(0, slash) : "";
  if (!account || slash === value.length - 1) return undefined;
  return { machine, account, value };
}

function forMachine(stored: readonly StoredFavorite[], machine: string): SpadeFavorite[] {
  const out: SpadeFavorite[] = [];
  for (const item of stored) {
    if (typeof item === "string") {
      const resolved = resolveLegacy(item, machine);
      if (resolved) out.push(resolved);
    } else if (item.machine === machine) {
      out.push(item);
    }
  }
  return out;
}

function migrate(stored: readonly StoredFavorite[], machine: string): StoredFavorite[] {
  return stored.map((item) =>
    typeof item === "string" ? (resolveLegacy(item, machine) ?? item) : item,
  );
}

/**
 * Stars for one machine, shared by every picker on the page. `isFavorite` and `toggle` take the
 * endpoint's account id, so the same endpoint slug on two machines or two sign-ins stays
 * separate. A write reads storage first, so it never puts a stale list back over another tab.
 */
export function useSpadeFavorites(machine: string) {
  const all = useSyncExternalStore(subscribe, snapshot, snapshot);
  // The first picker that can name a legacy star's machine and endpoint writes it as a record;
  // a string naming neither stays where it is.
  useEffect(() => {
    const migrated = migrate(all, machine);
    if (migrated.some((item, at) => item !== all[at])) write(migrated);
  }, [all, machine]);
  const favorites = useMemo(() => forMachine(all, machine), [all, machine]);
  const ids = useMemo(
    () =>
      new Set(favorites.map((favorite) => favoriteId(machine, favorite.account, favorite.value))),
    [favorites, machine],
  );
  const isFavorite = useCallback(
    (account: string, value: string) => ids.has(favoriteId(machine, account, value)),
    [ids, machine],
  );
  const toggle = useCallback(
    (account: string, value: string) => {
      const id = favoriteId(machine, account, value);
      const existing = migrate(readFresh(), machine);
      const has = existing.some(
        (favorite) =>
          typeof favorite !== "string" &&
          favoriteId(favorite.machine, favorite.account, favorite.value) === id,
      );
      write(
        has
          ? existing.filter(
              (favorite) =>
                typeof favorite === "string" ||
                favoriteId(favorite.machine, favorite.account, favorite.value) !== id,
            )
          : [{ machine, account, value }, ...existing],
      );
    },
    [machine],
  );
  return { favorites, isFavorite, toggle };
}
