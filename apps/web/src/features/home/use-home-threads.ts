import type { SidebarReader } from "@ace/client";
import { arrayEqual, useSidebar, type SidebarKey } from "@ace/client-react";
import type { ThreadListEntry } from "@ace/protocol";
import { useCallback, useDeferredValue, useMemo } from "react";
import { useNow } from "@/lib/time.ts";
import {
  activityOf,
  archivedOrder,
  placeReader,
  projectCounts,
  standingReader,
  threadMatches,
  threadTabs,
  type HomeSort,
  type ProjectCount,
  type Standing,
  type ThreadPlace,
  type ThreadsPanel,
} from "@ace/ui-core";
import { useModelCatalog } from "@/lib/model-catalog.ts";
import { useIsChatThread, useProjectName } from "@/lib/projects.ts";
import { useDaemonSetting } from "@/lib/daemon-setting.ts";
import { useOrganizeOverlay, useOrganizer, useOrganizerState } from "@/features/organize/index.ts";
import { usePendingActions } from "@/lib/pending-actions.ts";
import { usePrimaryMachine } from "@/lib/machines.ts";
import { machineRow } from "@/lib/machine-threads.ts";
import { useSidebarDevice } from "./device-filter-state.ts";

/** How Home orders the threads below Pinned (Settings › Agents › Sort threads). */
export function useHomeSort(): HomeSort {
  const [sortBy] = useDaemonSetting("threads.sortBy");
  return sortBy ?? "activity";
}

/**
 * Home's threads in the Threads panel's three places, as the daemon placed them (`threadTabs`):
 * the Inbox, band by band, with its pinned threads leading; Snoozed; and Settled.
 */
export interface HomeList {
  pinned: string[];
  /** The Inbox below its pinned threads, in its order. */
  listed: string[];
  snoozed: string[];
  /** Settled threads at rest that are loaded, most recent activity first. */
  settled: string[];
  /** The listed threads that need you, which may rise while the list otherwise holds still. */
  needsYou: string[];
  panel: ThreadsPanel;
}
const noPanel: ThreadsPanel = { inbox: [], pinned: [], snoozed: [], settled: [] };
const empty: HomeList = {
  pinned: [],
  listed: [],
  snoozed: [],
  settled: [],
  needsYou: [],
  panel: noPanel,
};
const noProjects: ProjectCount[] = [];
const noOthers: readonly ThreadListEntry[] = [];
const noFound: ReadonlyMap<string, unknown> = new Map();

const entriesOf = (reader: SidebarReader): ThreadListEntry[] =>
  reader.ids.flatMap((id) => {
    const entry = reader.thread(id);
    return entry ? [entry] : [];
  });

/** The list's entries as this window shows them, with organize actions not yet confirmed. */
export function useEntries(): (reader: SidebarReader) => ThreadListEntry[] {
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
const everyEntry: readonly SidebarKey[] = ["ids", "threads", "window", "homeWindow", "unconfirmed"];
export function useEveryEntryKey(): readonly SidebarKey[] {
  return everyEntry;
}

const listEqual = (a: HomeList, b: HomeList) =>
  arrayEqual(a.pinned, b.pinned) &&
  arrayEqual(a.listed, b.listed) &&
  arrayEqual(a.snoozed, b.snoozed) &&
  arrayEqual(a.settled, b.settled) &&
  arrayEqual(a.needsYou, b.needsYou) &&
  arrayEqual(a.panel.inbox, b.panel.inbox);

/**
 * Each entry's place: the daemon's, else the shared rule on this clock (an older daemon, or an
 * organize action not yet confirmed). A new catalog, baseline, sort or minute starts over.
 */
export function usePlaceOf(
  now: number,
  unconfirmed: boolean,
): (entry: ThreadListEntry) => ThreadPlace | undefined {
  const models = useModelCatalog();
  const sortBy = useHomeSort();
  const { baseline } = useOrganizer().getState();
  return useMemo(
    () => placeReader({ fallback: { baseline, now, models, sortBy }, unconfirmed }),
    [models, baseline, now, sortBy, unconfirmed],
  );
}

/** Each entry's standing on this clock (`standingReader`): a new catalog, baseline or minute starts over. */
export function useStandingOf(now: number): (entry: ThreadListEntry) => Standing {
  const models = useModelCatalog();
  const { baseline } = useOrganizer().getState();
  return useMemo(() => standingReader({ baseline, now, models }), [models, baseline, now]);
}

/**
 * The daemon's tabs (`threadTabs`) across every project and device the filter lets through.
 * Filters only narrow what comes in; the order is the daemon's. Chats (ADR 0099) are the Chats
 * panel's: they stay out of the Threads panel and History, as the Chats panel holds its own.
 * `typed` (deferred) narrows it to the threads whose title, project, branch or pull request match
 * (`threadMatches`, forgiving typos), and to those the daemon's search `found` in their messages.
 * Only ids are selected, so a status change re-renders its own row and moves rows only
 * when the order changes. `others` are other machines' threads under their machine row ids
 * (`useMachineEntries`), ordered in the same list (ADR 0102).
 */
export function useHomeList(
  others: readonly ThreadListEntry[] = noOthers,
  typed = "",
  found: ReadonlyMap<string, unknown> = noFound,
): HomeList {
  // The search box stays instant; the list filters in a later, interruptible render, so a fast
  // typist's keystrokes don't each wait on a pass over every thread.
  const query = useDeferredValue(typed);
  const keepTabs = useMemo(() => tabsKeeper(), []);
  const device = useSidebarDevice();
  const ownDevice = usePrimaryMachine().id;
  const keys = useEveryEntryKey();
  const state = useOrganizerState();
  const now = useNow();
  const read = useEntries();
  const placed = usePlaceOf(now, false);
  const syncing = usePlaceOf(now, true);
  const projectName = useProjectName();
  const isChatThread = useIsChatThread();
  const select = useCallback(
    (reader: SidebarReader): HomeList => {
      const own = read(reader);
      const all = others.length ? [...own, ...others] : own;
      const onDevice = device
        ? all.filter((entry) => (machineRow(entry.id)?.hostId ?? ownDevice) === device)
        : all;
      const project = state.project;
      const work = onDevice.filter(
        (entry) => !isChatThread(entry) && (project === null || entry.workspaceId === project),
      );
      const entries =
        query.trim().length > 0
          ? work.filter(
              (entry) =>
                threadMatches(entry, query, projectName(entry.workspaceId)) || found.has(entry.id),
            )
          : work;
      const byId = new Map<string, ThreadListEntry>(entries.map((entry) => [entry.id, entry]));
      // A saved list's statuses may be stale: its live bands claim nothing (its rows say Syncing).
      const panel = keepTabs(entries, reader.unconfirmed ? syncing : placed);
      const pinned = new Set(panel.pinned);
      const listed = panel.inbox.filter((id) => !pinned.has(id));
      const needsYou = reader.unconfirmed
        ? []
        : listed.filter((id) => byId.get(id)?.status.state === "needs_you");
      return {
        pinned: panel.pinned,
        listed,
        snoozed: panel.snoozed,
        settled: panel.settled,
        needsYou,
        panel,
      };
    },
    [
      state,
      read,
      others,
      device,
      ownDevice,
      query,
      found,
      projectName,
      placed,
      syncing,
      isChatThread,
      keepTabs,
    ],
  );
  return useSidebar(keys, select, listEqual) ?? empty;
}

/**
 * `threadTabs` that keeps its last panel while the same threads, in the same order, keep the same
 * places: a step or a status change that moves no thread (most of them), or the minute ticking
 * over, then costs one place read per thread and no sort. Pure but for the one panel it holds.
 */
export function tabsKeeper() {
  let last:
    | { ids: readonly string[]; places: readonly (ThreadPlace | undefined)[]; panel: ThreadsPanel }
    | undefined;
  return (
    entries: readonly ThreadListEntry[],
    place: (entry: ThreadListEntry) => ThreadPlace | undefined,
  ): ThreadsPanel => {
    const places = entries.map(place);
    const held = last;
    if (
      held &&
      held.ids.length === entries.length &&
      entries.every(
        (entry, index) =>
          entry.id === held.ids[index] && samePlace(places[index], held.places[index]),
      )
    )
      return held.panel;
    const byId = new Map(entries.map((entry, index) => [entry.id, places[index]]));
    const panel = threadTabs(entries, (entry) => byId.get(entry.id));
    last = { ids: entries.map((entry) => entry.id), places, panel };
    return panel;
  };
}

function samePlace(a: ThreadPlace | undefined, b: ThreadPlace | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.tab !== b.tab || a.band !== b.band) return false;
  return arrayEqual(a.rank, b.rank);
}

/** The top of the Home list: the Inbox's first thread, else the newest settled one. */
export function topThread(list: HomeList): string | undefined {
  return list.panel.inbox[0] ?? list.panel.settled[0];
}

/** Settled threads with when each last worked and its project, for History and search. */
export interface SettledEntry {
  id: string;
  /** When it last worked. */
  at: number;
  project: string;
}

const itemsEqual = (a: readonly SettledEntry[], b: readonly SettledEntry[]) =>
  a.length === b.length &&
  a.every((item, i) => {
    const other = b[i];
    return item.id === other?.id && item.at === other.at && item.project === other.project;
  });

/**
 * The settled threads `ids` names (as `useHomeList` orders them), each with its last activity
 * and project: what History groups by week and filters by project.
 */
export function useSettledEntries(ids: readonly string[]): readonly SettledEntry[] {
  const keys = useEveryEntryKey();
  const select = useCallback(
    (reader: SidebarReader) =>
      ids.flatMap((id): SettledEntry[] => {
        const entry = reader.thread(id);
        return entry ? [{ id, at: activityOf(entry), project: entry.workspaceId }] : [];
      }),
    [ids],
  );
  return useSidebar(keys, select, itemsEqual) ?? noSettled;
}
const noSettled: readonly SettledEntry[] = [];

const countsEqual = (a: ProjectCount[], b: ProjectCount[]) =>
  a.length === b.length && a.every((p, i) => p.id === b[i]?.id && p.threads === b[i]?.threads);

/** Projects that have threads here, with how many. */
export function useProjects(): ProjectCount[] {
  const keys = useEveryEntryKey();
  const read = useEntries();
  const select = useCallback(
    (reader: SidebarReader) =>
      reader.homeWindow?.counts ?? reader.window?.counts ?? projectCounts(read(reader)),
    [read],
  );
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
