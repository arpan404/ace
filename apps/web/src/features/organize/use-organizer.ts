// How this device shows the Home list (project filter, Settled open, the unread baseline and
// threads hiding for Undo). The organization itself (settled, snoozed, pinned, read, titles,
// deletion) is the daemon's and arrives on each thread list entry.
import { useSyncExternalStore } from "react";
import { useLayout } from "@/lib/layout.tsx";
import { type KeyValueStorage, Organizer, type OrganizerState } from "@ace/ui-core";

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
