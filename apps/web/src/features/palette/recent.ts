import type { KeyValueStorage } from "@ace/ui-core";
import { useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";

const key = "ace.palette.recent";
const kept = 5;

export interface RecentThread {
  id: string;
  /** When it was opened (ms). */
  at: number;
}

/** The threads opened most recently on this device, newest first. Bad data reads as none. */
export function readRecentThreads(storage: KeyValueStorage | undefined): RecentThread[] {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(key) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (entry): entry is RecentThread =>
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as RecentThread).id === "string" &&
          typeof (entry as RecentThread).at === "number",
      )
      .slice(0, kept);
  } catch {
    return [];
  }
}

/** Notes each thread as it opens, for the palette's Recent threads. */
export function useRecordRecentThreads(
  storage: KeyValueStorage | undefined,
  now: () => number,
): void {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const id = /^\/t\/([^/]+)$/.exec(pathname)?.[1];
  useEffect(() => {
    if (!id || !storage) return;
    const thread = decodeURIComponent(id);
    const rest = readRecentThreads(storage).filter((entry) => entry.id !== thread);
    storage.setItem(key, JSON.stringify([{ id: thread, at: now() }, ...rest].slice(0, kept)));
  }, [id, storage, now]);
}
