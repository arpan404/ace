import type { KeyValueStorage } from "@ace/ui-core";
import { useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";

const threadsKey = "ace.palette.recent";
const commandsKey = "ace.palette.commands";
/** Recent threads an empty palette lists. */
export const recentShown = 12;
const commandsKept = 20;

export interface RecentEntry {
  id: string;
  /** When it was opened or run (ms). */
  at: number;
}

function read(storage: KeyValueStorage | undefined, key: string, kept: number): RecentEntry[] {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(key) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (entry): entry is RecentEntry =>
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as RecentEntry).id === "string" &&
          typeof (entry as RecentEntry).at === "number",
      )
      .slice(0, kept);
  } catch {
    return [];
  }
}

function note(storage: KeyValueStorage, key: string, kept: number, id: string, at: number) {
  const rest = read(storage, key, kept).filter((entry) => entry.id !== id);
  storage.setItem(key, JSON.stringify([{ id, at }, ...rest].slice(0, kept)));
}

/** The threads opened most recently on this device, newest first. Bad data reads as none. */
export function readRecentThreads(storage: KeyValueStorage | undefined): RecentEntry[] {
  return read(storage, threadsKey, recentShown + 1);
}

/** The palette commands run most recently on this device, newest first. */
export function readRecentCommands(storage: KeyValueStorage | undefined): RecentEntry[] {
  return read(storage, commandsKey, commandsKept);
}

/** Notes a command run from the palette, so it ranks first among actions next time. */
export function rememberCommand(storage: KeyValueStorage | undefined, id: string, at: number) {
  if (storage) note(storage, commandsKey, commandsKept, id, at);
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
    note(storage, threadsKey, recentShown + 1, decodeURIComponent(id), now());
  }, [id, storage, now]);
}
