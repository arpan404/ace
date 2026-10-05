import type { SidebarReader } from "@ace/client";
import { arrayEqual, useSidebar, type SidebarKey } from "@ace/client-react";
import type { ThreadListEntry } from "@ace/protocol";
import { useCallback } from "react";
import { useNow } from "@/lib/time.ts";
import {
  arrange,
  groupHome,
  homeGroupsEqual,
  projectCounts,
  type HomeGroups,
  type ProjectCount,
} from "@ace/ui-core";
import {
  useOrganizeOverlay,
  useOrganizerState,
  usePendingActions,
} from "@/features/organize/index.ts";

/** Home's threads: pinned and by project folder, and Settled apart, each in Home order. */
export interface HomeList {
  groups: HomeGroups;
  settled: string[];
  /** The listed threads that need you, which may rise while the list otherwise holds still. */
  needsYou: string[];
}
const empty: HomeList = { groups: { pinned: [], projects: [] }, settled: [], needsYou: [] };
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
  homeGroupsEqual(a.groups, b.groups) &&
  arrayEqual(a.settled, b.settled) &&
  arrayEqual(a.needsYou, b.needsYou);

/**
 * Home order (needs you, moving, trouble, the rest; settled apart), pinned threads first and
 * the rest by project. Only ids are selected, so a status change re-renders its own row and
 * moves rows only when the order changes.
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
      const groups = groupHome(
        active.flatMap((id) => {
          const entry = byId.get(id);
          return entry
            ? [
                {
                  id,
                  project: entry.workspaceId,
                  pinned: entry.pinned === true,
                  needsYou: entry.status.state === "needs_you",
                },
              ]
            : [];
        }),
      );
      return { groups, settled, needsYou };
    },
    [state, now, read],
  );
  return useSidebar(keys, select, listEqual) ?? empty;
}

/** The top of the Home list: the first pinned thread, else the first thread in Home order. */
export function topThread(list: HomeList): string | undefined {
  return list.groups.pinned[0] ?? list.groups.projects[0]?.ids[0];
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
