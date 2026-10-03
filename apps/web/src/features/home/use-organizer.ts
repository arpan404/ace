import { useCallback, useSyncExternalStore } from "react";
import { useLayout } from "@/lib/layout.tsx";
import type { KeyValueStorage } from "@/lib/storage.ts";
import { Organizer, type OrganizerState, type ThreadMark } from "./organizer.ts";

// One organizer per injected storage, so each app instance (and each test) has its own.
const organizers = new WeakMap<KeyValueStorage, Organizer>();
let unstored: Organizer | undefined;

function organizerFor(storage: KeyValueStorage | undefined): Organizer {
  if (!storage) return (unstored ??= new Organizer(undefined, Date.now()));
  let organizer = organizers.get(storage);
  if (!organizer) {
    organizer = new Organizer(storage, Date.now());
    organizers.set(storage, organizer);
  }
  return organizer;
}

export function useOrganizer(): Organizer {
  return organizerFor(useLayout().storage);
}

export function useOrganizerState(): OrganizerState {
  const organizer = useOrganizer();
  return useSyncExternalStore(organizer.subscribe, organizer.getState, organizer.getState);
}

/** One thread's mark. Marks are replaced on change, so other rows don't re-render. */
export function useThreadMark(threadId: string): ThreadMark | undefined {
  const organizer = useOrganizer();
  const read = useCallback(() => organizer.mark(threadId), [organizer, threadId]);
  return useSyncExternalStore(organizer.subscribe, read, read);
}
