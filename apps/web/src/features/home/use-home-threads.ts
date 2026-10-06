import type { SidebarReader } from "@ace/client";
import { arrayEqual, useSidebar, type SidebarKey } from "@ace/client-react";
import type { ThreadListEntry } from "@ace/protocol";
import { useCallback } from "react";
import { useNow } from "@/lib/time.ts";
import { archivedOrder, arrange, homeOrder, projectCounts, type ProjectCount } from "@ace/ui-core";
import { useOrganizeOverlay, useOrganizerState } from "@/features/organize/index.ts";
import { usePendingActions } from "@/lib/pending-actions.ts";

/** Home's threads: pinned first, then the rest in Home order, and Settled apart. */
export interface HomeList {
  active: string[];
  settled: string[];
  /** The listed threads that need you, which may rise while the list otherwise holds still. */
  needsYou: string[];
}
const empty: HomeList = { active: [], settled: [], needsYou: [] };
const noProjects: ProjectCount[] = [];

const entriesOf = (reader: SidebarReader): ThreadListEntry[] =>
  reader.ids.flatMap((id) => {
    const entry = reader.thread(id);
    return entry ? [entry] : [];
  });

/** The list's entries as this window shows them, with organize actions not yet confirmed. */
function useEntries(): (reader: SidebarReader) => ThreadListEntry[] {
  const overlay = useOrganizeOverlay();
  const pending = usePendingActions();
  return useCallback(
    (reader: SidebarReader) => {
      const entries = entriesOf(reader);
      return pending.length ? entries.map((entry) => overlay.apply(entry)) : entries;
    },
    [overlay, pending],
  );
}

/** Keys for every entry, so a selection over the whole list sees each status change. */
// `threads` changes with any entry, so one key covers the whole list at any size.
const everyEntry: readonly SidebarKey[] = ["ids", "threads"];
function useEveryEntryKey(): readonly SidebarKey[] {
  return everyEntry;
}

const listEqual = (a: HomeList, b: HomeList) =>
  arrayEqual(a.active, b.active) &&
  arrayEqual(a.settled, b.settled) &&
  arrayEqual(a.needsYou, b.needsYou);

/**
 * Home order (needs you, moving, trouble, the rest, most recent first in each; settled apart),
 * pinned threads first, across every project the filter lets through. Only ids are selected, so
 * a status change re-renders its own row and moves rows only when the order changes.
 */
export function useHomeList(): HomeList {
  const keys = useEveryEntryKey();
  const state = useOrganizerState();
  const now = useNow();
  const read = useEntries();
  const select = useCallback(
    (reader: SidebarReader): HomeList => {
      const entries = read(reader);
      const { active, settled } = arrange(entries, state, now);
      const byId = new Map<string, ThreadListEntry>(entries.map((entry) => [entry.id, entry]));
      const needsYou = active.filter((id) => byId.get(id)?.status.state === "needs_you");
      const ordered = homeOrder(
        active.map((id) => ({ id, pinned: byId.get(id)?.pinned === true })),
      );
      return { active: ordered, settled, needsYou };
    },
    [state, now, read],
  );
  return useSidebar(keys, select, listEqual) ?? empty;
}

/** The top of the Home list: the first pinned thread, else the first thread in Home order. */
export function topThread(list: HomeList): string | undefined {
  return list.active[0];
}

const countsEqual = (a: ProjectCount[], b: ProjectCount[]) =>
  a.length === b.length && a.every((p, i) => p.id === b[i]?.id && p.threads === b[i]?.threads);

/** Projects that have threads here, with how many. */
export function useProjects(): ProjectCount[] {
  const keys = useEveryEntryKey();
  const read = useEntries();
  const select = useCallback((reader: SidebarReader) => projectCounts(read(reader)), [read]);
  return useSidebar(keys, select, countsEqual) ?? noProjects;
}

const noIds: readonly string[] = [];

/**
 * The archive, within the project filter: archived threads not deleted, most recently archived
 * first, with organize actions not yet confirmed (a Restore leaves it at once).
 */
export function useArchivedList(): readonly string[] {
  const keys = useEveryEntryKey();
  const { project } = useOrganizerState();
  const read = useEntries();
  const select = useCallback(
    (reader: SidebarReader) => archivedOrder(read(reader), { project }),
    [read, project],
  );
  return useSidebar(keys, select, arrayEqual) ?? noIds;
}
