import { parentPath } from "@ace/ui-core";
import { useCallback, useSyncExternalStore } from "react";
import { LocalStore } from "../store.ts";

/*
 * What this window changed in a checkout, per thread, for the lazy tree: a file operation names
 * the folders whose rows it changed (the parents of the paths it touched, source and
 * destination). The daemon's watcher announces what agents did with files.folders_changed, so
 * nothing here is bumped from a push.
 */

/** One mutation's folders: the parent folder of each path it created, moved or removed. */
export interface RefreshEvent {
  version: number;
  folders: readonly string[];
}

interface ThreadRefresh {
  version: number;
  events: readonly RefreshEvent[];
}

/** How many mutations a tree may fall behind before old ones are dropped. */
const keptEvents = 32;

export const checkoutRefresh = new LocalStore<Readonly<Record<string, ThreadRefresh>>>({});

/** Record this window's mutation of `paths`, source and destination when it moved something. */
export function checkoutChanged(threadId: string, paths: readonly (string | undefined)[]): void {
  const folders = [
    ...new Set(paths.filter((path): path is string => !!path).map((path) => parentPath(path))),
  ];
  if (!folders.length) return;
  checkoutRefresh.set((all) => {
    const current = all[threadId] ?? { version: 0, events: [] };
    const version = current.version + 1;
    return {
      ...all,
      [threadId]: { version, events: [...current.events, { version, folders }].slice(-keptEvents) },
    };
  });
}

const versionOf = (all: Readonly<Record<string, ThreadRefresh>>, threadId: string) =>
  all[threadId]?.version ?? 0;

/** The thread's refresh version; a tree lists again the folders of the events it hasn't seen. */
export function useCheckoutRefresh(threadId: string): number {
  const read = useCallback(() => versionOf(checkoutRefresh.get(), threadId), [threadId]);
  return useSyncExternalStore(checkoutRefresh.subscribe, read, read);
}

/** This window's mutations after `after`, oldest first, each naming the folders they changed. */
export function refreshEvents(
  threadId: string,
  after: number,
  all: Readonly<Record<string, ThreadRefresh>> = checkoutRefresh.get(),
): readonly RefreshEvent[] {
  return (all[threadId]?.events ?? []).filter((event) => event.version > after);
}
