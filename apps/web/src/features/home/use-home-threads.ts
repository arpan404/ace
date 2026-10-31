import type { SidebarReader } from "@ace/client";
import { arrayEqual, useSidebar, type SidebarKey } from "@ace/client-react";
import type { ThreadListEntry } from "@ace/protocol";
import { useCallback, useMemo } from "react";
import { useNow } from "@/lib/time.ts";
import {
  activeGroupKeys,
  activeGroups,
  createdGroups,
  manualGroups,
  activityOf,
  archivedOrder,
  arrange,
  laneReader,
  projectCounts,
  threadMatches,
  type ActiveGroups,
  type HomeLane,
  type HomeSort,
  type ProjectCount,
  type SettledItem,
} from "@ace/ui-core";
import { useModelCatalog } from "@/lib/model-catalog.ts";
import { useProjectName } from "@/lib/projects.ts";
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
 * Home's threads: pinned first in their own order, then the work in hand in Home order, then
 * Recent (threads at rest), Settled apart. Sorted by creation or by hand, every thread below
 * Pinned is in Recent. `groups` splits Active and Recent into the Threads panel's groups, and
 * `listed` is every thread below Pinned in the order the panel draws them.
 */
export interface HomeList {
  pinned: string[];
  active: string[];
  recent: string[];
  groups: ActiveGroups;
  listed: string[];
  snoozed: string[];
  settled: string[];
  /** The listed threads that need you, which may rise while the list otherwise holds still. */
  needsYou: string[];
}
const noGroups: ActiveGroups = {
  "needs-you": [],
  running: [],
  today: [],
  yesterday: [],
  week: [],
  earlier: [],
  listed: [],
};
const empty: HomeList = {
  pinned: [],
  active: [],
  recent: [],
  groups: noGroups,
  listed: [],
  snoozed: [],
  settled: [],
  needsYou: [],
};
const noProjects: ProjectCount[] = [];
const noOthers: readonly ThreadListEntry[] = [];

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
const everyEntry: readonly SidebarKey[] = ["ids", "threads", "window", "homeWindow", "unconfirmed"];
function useEveryEntryKey(): readonly SidebarKey[] {
  return everyEntry;
}

const listEqual = (a: HomeList, b: HomeList) =>
  arrayEqual(a.pinned, b.pinned) &&
  activeGroupKeys.every((key) => arrayEqual(a.groups[key], b.groups[key])) &&
  arrayEqual(a.active, b.active) &&
  arrayEqual(a.recent, b.recent) &&
  arrayEqual(a.snoozed, b.snoozed) &&
  arrayEqual(a.settled, b.settled) &&
  arrayEqual(a.needsYou, b.needsYou);

/** Each entry's lane on this clock (`laneReader`): a new catalog, baseline or minute starts over. */
function useLaneOf(now: number): (entry: ThreadListEntry) => HomeLane {
  const models = useModelCatalog();
  const { baseline } = useOrganizer().getState();
  return useMemo(() => laneReader({ baseline, now, models }), [models, baseline, now]);
}

/**
 * Pinned threads in the person's order, then Home order (requests, working, then the rest,
 * most recent first in each; settled apart), across every project the filter lets through,
 * split into the Threads panel's groups. `query` narrows it to the threads whose title,
 * project, branch or pull request match. Only ids are selected, so a status change re-renders
 * its own row and moves rows only when the order changes. `others` are other machines' threads
 * under their machine row ids (`useMachineEntries`), ordered in the same list (ADR 0102).
 */
export function useHomeList(others: readonly ThreadListEntry[] = noOthers, query = ""): HomeList {
  const device = useSidebarDevice();
  const ownDevice = usePrimaryMachine().id;
  const keys = useEveryEntryKey();
  const state = useOrganizerState();
  const sortBy = useHomeSort();
  const now = useNow();
  const read = useEntries();
  const laneOf = useLaneOf(now);
  const projectName = useProjectName();
  const select = useCallback(
    (reader: SidebarReader): HomeList => {
      const own = read(reader);
      const all = others.length ? [...own, ...others] : own;
      const onDevice = device
        ? all.filter((entry) => (machineRow(entry.id)?.hostId ?? ownDevice) === device)
        : all;
      const entries = query.trim()
        ? onDevice.filter((entry) => threadMatches(entry, query, projectName(entry.workspaceId)))
        : onDevice;
      const { pinned, active, recent, snoozed, settled } = arrange(
        entries,
        { ...state, sortBy },
        now,
      );
      const byId = new Map<string, ThreadListEntry>(entries.map((entry) => [entry.id, entry]));
      const below = [...active, ...recent].flatMap((id) => byId.get(id) ?? []);
      // Live activity groups by what needs you and what runs; the other sorts keep their order.
      const groups =
        sortBy === "activity"
          ? activeGroups(below, laneOf, now)
          : sortBy === "created"
            ? createdGroups(below, now)
            : manualGroups(below);
      const listed = activeGroupKeys.flatMap((key) => groups[key]);
      // A saved list's requests may have been answered since: none counts until it is confirmed.
      const needsYou = reader.unconfirmed
        ? []
        : listed.filter((id) => byId.get(id)?.status.state === "needs_you");
      return { pinned, active, recent, groups, listed, snoozed, settled, needsYou };
    },
    [state, sortBy, now, read, others, device, ownDevice, query, projectName, laneOf],
  );
  return useSidebar(keys, select, listEqual) ?? empty;
}

/** The top of the Home list: the first pinned thread, else the first thread the panel lists. */
export function topThread(list: HomeList): string | undefined {
  return list.pinned[0] ?? list.listed[0];
}

/** Settled threads with when each last worked and its project, for the Settled tab. */
export interface SettledEntry extends SettledItem {
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
 * and project: what the Settled tab groups by week and filters by project.
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
