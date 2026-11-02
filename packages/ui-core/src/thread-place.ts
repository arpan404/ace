import type {
  InboxBand,
  ListAttention,
  PlaceAttention as WirePlaceAttention,
  ThreadListEntry,
  ThreadPlace,
  ThreadTab,
} from "@ace/protocol";
import {
  homeListKey,
  isDraft,
  isRemoteChild,
  isRemoved,
  pinOrderOf,
  type HomeSort,
} from "./arrange.ts";
import { activityOf, isSettled, isSnoozed } from "./thread-state.ts";
import {
  atRest,
  atWork,
  needsPerson,
  standingOf,
  type Standing,
  type StandingInput,
} from "./thread-standing.ts";

/*
 * Where a thread sits in the Threads panel (ADR 0107, "Inbox, Snoozed, Settled"). The daemon
 * runs `placeThread` on every listed thread and sends the result with it, so web, desktop and
 * the phone show one placement. Clients only read the places (`threadTabs`), filter them and
 * merge machines by them; they run `placeThread` themselves only for an entry that came without
 * one (an older daemon, or an organize action not yet confirmed), so nothing can drift.
 *
 * The Inbox holds every unsettled, unsnoozed thread, in the order the person would act: pinned,
 * then what needs them, then what runs (its whole agent tree counted), then finished work not
 * yet looked at, then the rest, each band newest first. Snoozed holds what waits, soonest first;
 * Settled what is done, newest first. A settled thread returns to the Inbox only while it needs
 * the person or its agents work; held at a usage limit, or with only a command left running, it
 * stays in Settled. Placement reads the row attention (`standingOf`), so a band never disagrees
 * with the row's own status word. Pure: the caller passes the clock.
 */

export type { ThreadTab, InboxBand, ThreadPlace } from "@ace/protocol";

export const threadsTabs: readonly { id: ThreadTab; label: string }[] = [
  { id: "inbox", label: "Inbox" },
  { id: "snoozed", label: "Snoozed" },
  { id: "settled", label: "Settled" },
];

export interface PlaceInput extends StandingInput {
  /** How the Inbox orders unpinned threads (`threads.sortBy`). */
  sortBy?: HomeSort | undefined;
}

/** The Inbox band a thread's standing puts it in, sorted by live activity. */
function bandOf(standing: Standing): InboxBand {
  if (needsPerson(standing)) return "needs-you";
  if (atWork(standing)) return "running";
  return standing.level === "done-unread" ? "unseen" : "idle";
}

/** A thread's place with the standing it was read from (`placeThread`). */
export interface PlacedStanding {
  place: ThreadPlace;
  standing: Standing;
}

/**
 * Where a thread sits, or undefined when the panel leaves it out: archived, deleted, a draft
 * nobody sent, or a child delegated here from another machine (#1562). A request is never
 * hidden by a snooze; a pinned thread snoozes and settles like any other.
 */
export function placeThread(entry: ThreadListEntry, input: PlaceInput): ThreadPlace | undefined {
  return placeWithStanding(entry, input)?.place;
}

/** `placeThread`, with the standing it read, for the rail's dots (`threadSignal`). */
export function placeWithStanding(
  entry: ThreadListEntry,
  input: PlaceInput,
): PlacedStanding | undefined {
  if (isRemoved(entry) || isDraft(entry) || isRemoteChild(entry)) return undefined;
  const at = activityOf(entry);
  const standing = standingOf(entry, input);
  const placed = (place: ThreadPlace) => ({ place, standing });
  if (entry.status.state !== "needs_you" && isSnoozed(entry, input.now))
    return placed({ tab: "snoozed", rank: [-(entry.snoozedUntil ?? 0), at] });
  if (isSettled(entry) && atRest(standing)) return placed({ tab: "settled", rank: [at] });
  if (entry.pinned === true)
    return placed({ tab: "inbox", band: "pinned", rank: [pinOrderOf(entry), at] });
  const sortBy = input.sortBy ?? "activity";
  if (sortBy !== "activity")
    return placed({ tab: "inbox", band: "listed", rank: [homeListKey(sortBy)(entry)] });
  return placed({ tab: "inbox", band: bandOf(standing), rank: [at] });
}

const bandOrder: readonly InboxBand[] = [
  "pinned",
  "needs-you",
  "running",
  "unseen",
  "idle",
  "listed",
];
const bandIndex = (band: InboxBand | undefined) => (band ? bandOrder.indexOf(band) : 0);

/** A placed thread: its id (unique within the list being ordered) and its place. */
export interface Placed {
  id: string;
  place: ThreadPlace;
}

/** The order within one tab: band, then each rank key higher first, then id. */
export function comparePlaced(a: Placed, b: Placed): number {
  const band = bandIndex(a.place.band) - bandIndex(b.place.band);
  if (band !== 0) return band;
  const length = Math.max(a.place.rank.length, b.place.rank.length);
  for (let i = 0; i < length; i++) {
    const diff = (b.place.rank[i] ?? 0) - (a.place.rank[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The three tabs' threads, top to bottom. */
export interface ThreadsPanel {
  /** The Inbox, band by band. */
  inbox: string[];
  /** The pinned threads that lead the Inbox. */
  pinned: string[];
  /** Snoozed threads, the soonest to wake first. */
  snoozed: string[];
  /** Settled threads that are loaded, most recent activity first. */
  settled: string[];
}

export interface PlaceReaderInput {
  /** Places an entry that came without one (an older daemon, an unconfirmed organize action). */
  fallback: PlaceInput;
  /**
   * The list is a copy the daemon hasn't confirmed (read back from disk): its statuses may be
   * stale, so the Inbox's live bands claim nothing and fold into one list by activity.
   */
  unconfirmed?: boolean | undefined;
}

/**
 * The daemon's place, unless time has overtaken it: a snooze that ran out on this device's
 * clock while its machine couldn't say so (offline, or not yet swept) is placed by the same
 * rule now. Undefined when the entry came without a place.
 */
export function currentPlace(entry: ThreadListEntry, now: number): ThreadPlace | undefined {
  const place = entry.place;
  if (place?.tab === "snoozed" && !isSnoozed(entry, now)) return undefined;
  return place;
}

const live: ReadonlySet<InboxBand> = new Set(["needs-you", "running", "unseen", "idle"]);

/**
 * Each entry's place as the panel shows it: the daemon's, else `placeThread` on the fallback
 * clock. Worked out once per entry snapshot: entries are replaced, never changed.
 */
export function placeReader(
  input: PlaceReaderInput,
): (entry: ThreadListEntry) => ThreadPlace | undefined {
  const known = new WeakMap<ThreadListEntry, { place: ThreadPlace | undefined }>();
  return (entry) => {
    const hit = known.get(entry);
    if (hit) return hit.place;
    let place = currentPlace(entry, input.fallback.now) ?? placeThread(entry, input.fallback);
    if (input.unconfirmed && place?.band !== undefined && live.has(place.band))
      place = { ...place, band: "idle", rank: [activityOf(entry)] };
    known.set(entry, { place });
    return place;
  };
}

/**
 * The tabs from placed entries, as given: no rule here decides a place, it only groups and
 * orders by the places. Entries come from any number of machines, each with an id unique in the
 * list; filters (project, device, search) narrow the entries first without reordering.
 */
export function threadTabs(
  entries: Iterable<ThreadListEntry>,
  place: (entry: ThreadListEntry) => ThreadPlace | undefined,
): ThreadsPanel {
  const tabs: Record<ThreadTab, Placed[]> = { inbox: [], snoozed: [], settled: [] };
  for (const entry of entries) {
    const at = place(entry);
    if (at) tabs[at.tab].push({ id: entry.id, place: at });
  }
  const ids = (rows: Placed[]) => rows.toSorted(comparePlaced).map((row) => row.id);
  const inbox = tabs.inbox.toSorted(comparePlaced);
  return {
    inbox: inbox.map((row) => row.id),
    pinned: inbox.filter((row) => row.place.band === "pinned").map((row) => row.id),
    snoozed: ids(tabs.snoozed),
    settled: ids(tabs.settled),
  };
}

/** The rail places whose dots read their own threads (DESIGN.md §3, Rail). */
export type SignalPlace = "threads" | "chats";

/** What one rail place's dot reads: how many of its threads need the person or hold news. */
export type PlaceAttention = WirePlaceAttention;
/** Both rail places' dots, as the daemon sends them with a list (`ListAttention`). */
export type PlaceAttentions = ListAttention;

/** What one listed thread adds to its place's dot, if anything. */
export interface ThreadSignal {
  place: SignalPlace;
  needsYou: boolean;
  unread: boolean;
}

/**
 * A thread's part in its rail place's dot. Only what the place lists live counts: a thread in
 * its Inbox (snoozed threads that need the person are there too). A settled or snoozed thread at
 * rest draws no unread mark in its list, so it never lights the dot either. A request asks
 * loudest; a failure or finished work not yet opened is news.
 */
export function threadSignal(
  place: ThreadPlace | undefined,
  standing: Standing,
  chat: boolean,
): ThreadSignal | undefined {
  if (place?.tab !== "inbox") return undefined;
  const needsYou = standing.level === "needs-you";
  const unread = standing.level === "failed" || standing.level === "done-unread";
  if (!needsYou && !unread) return undefined;
  return { place: chat ? "chats" : "threads", needsYou, unread };
}

export const noAttention: PlaceAttentions = {
  threads: { needsYou: 0, unread: 0 },
  chats: { needsYou: 0, unread: 0 },
};

/** Running totals of `threadSignal`s: add a thread's part, take back its old one. */
export function withSignal(
  totals: PlaceAttentions,
  signal: ThreadSignal | undefined,
  sign: 1 | -1,
): PlaceAttentions {
  if (!signal) return totals;
  const place = totals[signal.place];
  return {
    ...totals,
    [signal.place]: {
      needsYou: place.needsYou + (signal.needsYou ? sign : 0),
      unread: place.unread + (signal.unread ? sign : 0),
    },
  };
}

/** Two places' totals together: every machine's list adds to the same dots. */
export function addAttention(a: PlaceAttentions, b: PlaceAttentions): PlaceAttentions {
  return {
    threads: {
      needsYou: a.threads.needsYou + b.threads.needsYou,
      unread: a.threads.unread + b.threads.unread,
    },
    chats: {
      needsYou: a.chats.needsYou + b.chats.needsYou,
      unread: a.chats.unread + b.chats.unread,
    },
  };
}

/**
 * A whole window placed at once: each entry with its place, and the rail's dots for what it
 * places live. The daemon does the same work per changed thread; a host that keeps no state
 * between updates (the fake daemon) runs this over its window.
 */
export function placeWindow(
  entries: readonly ThreadListEntry[],
  input: PlaceInput,
  isChat: (entry: ThreadListEntry) => boolean,
): { threads: ThreadListEntry[]; attention: PlaceAttentions } {
  let attention = noAttention;
  const threads = entries.map((entry) => {
    const { place: _old, ...rest } = entry;
    const found = placeWithStanding(entry, input);
    if (!found) return rest;
    attention = withSignal(attention, threadSignal(found.place, found.standing, isChat(entry)), 1);
    return { ...rest, place: found.place };
  });
  return { threads, attention };
}
