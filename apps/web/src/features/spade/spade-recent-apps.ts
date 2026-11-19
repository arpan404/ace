import { useCallback, useState } from "react";

/*
 * The catalogue apps the person reached for lately on this device (started connecting), latest
 * first, so the Connect an app list leads with them. Kept in the browser's storage, a few ids
 * only; never sent anywhere.
 */

const KEY = "ace.spade.recent-apps";
const MOST = 6;

/** The storage this reads and writes: the browser's, or a test's. */
export type RecentStorage = Pick<Storage, "getItem" | "setItem">;

export function readRecentApps(storage: RecentStorage | undefined): string[] {
  try {
    const raw: unknown = JSON.parse(storage?.getItem(KEY) ?? "[]");
    return Array.isArray(raw)
      ? raw.filter((id): id is string => typeof id === "string").slice(0, MOST)
      : [];
  } catch {
    return [];
  }
}

/** Puts `id` first, keeping the last few. Storage that refuses (private mode, full) is ignored. */
export function rememberRecentApp(storage: RecentStorage | undefined, id: string): string[] {
  const next = [id, ...readRecentApps(storage).filter((each) => each !== id)].slice(0, MOST);
  try {
    storage?.setItem(KEY, JSON.stringify(next));
  } catch {
    // Nothing to keep it in: the list just doesn't lead with it next time.
  }
  return next;
}

const browserStorage = (): RecentStorage | undefined => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
};

/**
 * The recent apps as they were when the list opened, and a way to put one first. The open list
 * keeps its order, so a row never moves away under the person's pointer; the next one leads
 * with it.
 */
export function useRecentApps(): [readonly string[], (id: string) => void] {
  const [list] = useState(() => readRecentApps(browserStorage()));
  const remember = useCallback((id: string) => void rememberRecentApp(browserStorage(), id), []);
  return [list, remember];
}
