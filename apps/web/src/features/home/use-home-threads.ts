import type { SidebarReader } from "@ace/client";
import { arrayEqual, useSidebar, type SidebarKey } from "@ace/client-react";
import type { ThreadListEntry } from "@ace/protocol";
import { useCallback, useMemo } from "react";
import { useNow } from "@/lib/time.ts";
import {
  activityOf,
  archivedOrder,
  arrange,
  homeTree,
  isDraft,
  isRemoved,
  isSettled,
  projectCounts,
  standingReader,
  threadMatches,
  type HomeSort,
  type HomeTree,
  type ProjectCount,
  type Standing,
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
 * Home's threads: pinned ones in their own order, every other open thread in Home order,
 * Snoozed and Settled apart, and the Threads panel's tree over them (`homeTree`): the Inbox,
 * Running, Recent and each project's threads.
 */
export interface HomeList {
  pinned: string[];
  /** Open threads below Pinned, in Home order. */
  listed: string[];
  snoozed: string[];
  settled: string[];
  /** The listed threads that need you, which may rise while the list otherwise holds still. */
  needsYou: string[];
  tree: HomeTree;
}
const syncing = (): Standing => ({ level: "syncing", done: false });
const noTree: HomeTree = { inbox: [], running: [], recent: [], projects: [], quiet: [], order: [] };
const empty: HomeList = {
  pinned: [],
  listed: [],
  snoozed: [],
  settled: [],
  needsYou: [],
  tree: noTree,
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

const treeEqual = (a: HomeTree, b: HomeTree) =>
  arrayEqual(a.inbox, b.inbox) &&
  arrayEqual(a.running, b.running) &&
  arrayEqual(a.order, b.order) &&
  a.recent.length === b.recent.length &&
  a.recent.every((item, i) => {
    const other = b.recent[i];
    return item.id === other?.id && item.at === other.at && item.settled === other.settled;
  }) &&
  [a.projects, a.quiet].every((places, which) => {
    const others = which === 0 ? b.projects : b.quiet;
    return (
      places.length === others.length &&
      places.every((place, i) => {
        const other = others[i];
        return (
          other !== undefined &&
          place.id === other.id &&
          place.running === other.running &&
          place.inbox === other.inbox &&
          place.settledTotal === other.settledTotal &&
          arrayEqual(place.threads, other.threads) &&
          arrayEqual(place.open, other.open) &&
          arrayEqual(place.settled, other.settled)
        );
      })
    );
  });

const listEqual = (a: HomeList, b: HomeList) =>
  arrayEqual(a.pinned, b.pinned) &&
  arrayEqual(a.listed, b.listed) &&
  arrayEqual(a.snoozed, b.snoozed) &&
  arrayEqual(a.settled, b.settled) &&
  arrayEqual(a.needsYou, b.needsYou) &&
  treeEqual(a.tree, b.tree);

/** Each entry's standing on this clock (`standingReader`): a new catalog, baseline or minute starts over. */
function useStandingOf(now: number): (entry: ThreadListEntry) => Standing {
  const models = useModelCatalog();
  const { baseline } = useOrganizer().getState();
  return useMemo(() => standingReader({ baseline, now, models }), [models, baseline, now]);
}

/**
 * Settled threads per project the daemon still holds back: its count of a project's threads
 * less the ones loaded that it doesn't page (every open thread is loaded). Undefined once
 * every settled thread is loaded.
 */
function settledCounts(
  reader: SidebarReader,
  entries: readonly ThreadListEntry[],
  project: string | null,
): Map<string, number> | undefined {
  const window = reader.homeWindow;
  if (!window?.before || window !== reader.window) return undefined;
  const live = new Map<string, number>();
  for (const entry of entries) {
    if (isRemoved(entry) || isDraft(entry)) continue;
    // The daemon pages settled threads that aren't pinned; every other one it sends at once.
    if (isSettled(entry) && entry.pinned !== true) continue;
    live.set(entry.workspaceId, (live.get(entry.workspaceId) ?? 0) + 1);
  }
  const counts = new Map<string, number>();
  for (const count of window.counts) {
    if (project !== null && count.id !== project) continue;
    counts.set(count.id, Math.max(0, count.threads - (live.get(count.id) ?? 0)));
  }
  return counts;
}

/**
 * Home order (`arrange`) across every project the filter lets through, and the Threads panel's
 * tree over it. `query` narrows it to the threads whose title, project, branch or pull request
 * match. Only ids are selected, so a status change re-renders its own row and moves rows only
 * when the order changes. `others` are other machines' threads under their machine row ids
 * (`useMachineEntries`), ordered in the same list (ADR 0102).
 */
export function useHomeList(others: readonly ThreadListEntry[] = noOthers, query = ""): HomeList {
  const device = useSidebarDevice();
  const ownDevice = usePrimaryMachine().id;
  const keys = useEveryEntryKey();
  const state = useOrganizerState();
  const sortBy = useHomeSort();
  const now = useNow();
  const read = useEntries();
  const standingOf = useStandingOf(now);
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
      const arrangement = arrange(entries, { ...state, sortBy }, now);
      const byId = new Map<string, ThreadListEntry>(entries.map((entry) => [entry.id, entry]));
      // The daemon's counts are this machine's own, and only while nothing narrows the list.
      const counts =
        query.trim() || (device && device !== ownDevice)
          ? undefined
          : settledCounts(reader, own, state.project);
      const tree = homeTree({
        arrangement,
        entry: (id) => byId.get(id),
        // A saved list's statuses may be stale: it claims nothing (as its rows say Syncing).
        standing: reader.unconfirmed ? syncing : standingOf,
        sortBy,
        now,
        settledCounts: counts,
      });
      const listed = [...arrangement.active, ...arrangement.recent];
      const needsYou = reader.unconfirmed
        ? []
        : listed.filter((id) => byId.get(id)?.status.state === "needs_you");
      return {
        pinned: arrangement.pinned,
        listed,
        snoozed: arrangement.snoozed,
        settled: arrangement.settled,
        needsYou,
        tree,
      };
    },
    [state, sortBy, now, read, others, device, ownDevice, query, projectName, standingOf],
  );
  return useSidebar(keys, select, listEqual) ?? empty;
}

/** The top of the Home list: the first thread the panel's tree lists. */
export function topThread(list: HomeList): string | undefined {
  return list.tree.order[0] ?? list.pinned[0];
}

/** Settled threads with when each last worked and its project, for the Settled tab. */
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
