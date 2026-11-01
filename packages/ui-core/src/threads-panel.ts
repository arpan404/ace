import type { CatalogModel, ThreadListEntry } from "@ace/protocol";
import type { Arrangement, HomeSort } from "./arrange.ts";
import type { AttentionLevel } from "./row-attention.ts";
import { threadCard } from "./thread-card.ts";
import { activityOf, isSettled } from "./thread-state.ts";

/*
 * The Threads panel (ADR 0107, "Inbox, Snoozed, Settled"): three places, like mail. The Inbox is
 * one flat list of every unsettled, unsnoozed thread across projects and machines, in the order
 * the person would act: pinned, then what needs them (a request, an unseen failure), then what
 * runs (its whole agent tree counted), then finished work not yet looked at, then the rest, each
 * band by latest activity. Snoozed holds what waits for a time or an event; Settled what is done,
 * newest first. Projects and devices only filter the threads that come in. Every placement reads
 * the row attention every row draws (`threadCard` → `rowAttention`), so a band never disagrees
 * with the row's own status word, and a settled thread whose tree still works or asks is in the
 * Inbox, never in Settled. Pure: the caller passes the clock.
 */

/** The panel's three places. */
export type ThreadsTab = "inbox" | "snoozed" | "settled";

export const threadsTabs: readonly { id: ThreadsTab; label: string }[] = [
  { id: "inbox", label: "Inbox" },
  { id: "snoozed", label: "Snoozed" },
  { id: "settled", label: "Settled" },
];

/** How a listed thread stands, from its row attention. */
export interface Standing {
  level: AttentionLevel;
  /** Its status is done (finished work), whatever the person has seen. */
  done: boolean;
}

export interface StandingInput {
  /** Activity before this moment counts as seen (the organizer's first-launch baseline). */
  baseline: number;
  now: number;
  models?: readonly CatalogModel[] | undefined;
}

/** A thread's standing, read as its row reads it. */
export function standingOf(entry: ThreadListEntry, input: StandingInput): Standing {
  const card = threadCard({
    entry,
    baseline: input.baseline,
    now: input.now,
    settled: false,
    models: input.models,
  });
  return { level: card.attention.level, done: entry.status.state === "done" };
}

/**
 * `standingOf` for one clock, catalog and baseline, worked out once per entry snapshot: entries
 * are replaced, never changed, so a list update re-reads only the threads that changed.
 */
export function standingReader(input: StandingInput): (entry: ThreadListEntry) => Standing {
  const known = new WeakMap<ThreadListEntry, Standing>();
  return (entry) => {
    let standing = known.get(entry);
    if (standing === undefined) {
      standing = standingOf(entry, input);
      known.set(entry, standing);
    }
    return standing;
  };
}

/** Needs the person: a request (approval, question, plan) or a failure they haven't seen. */
export function needsPerson(standing: Standing): boolean {
  return standing.level === "needs-you" || standing.level === "failed";
}

/** At work: working, background commands, waiting, its whole agent tree included. */
export function atWork(standing: Standing): boolean {
  return standing.level === "active";
}

/** A settled thread at rest: its tree neither works nor asks, so it belongs in Settled. */
export function atRest(standing: Standing): boolean {
  return !atWork(standing) && standing.level !== "needs-you";
}

/** The Inbox's bands, top to bottom. */
export type InboxBand = "pinned" | "needs-you" | "running" | "unseen" | "idle";

/** Which band a thread in the Inbox sits in. */
export function inboxBand(standing: Standing, pinned: boolean): InboxBand {
  if (pinned) return "pinned";
  if (needsPerson(standing)) return "needs-you";
  if (atWork(standing)) return "running";
  return standing.level === "done-unread" ? "unseen" : "idle";
}

const newest = (a: { id: string; at: number }, b: { id: string; at: number }) =>
  b.at - a.at || a.id.localeCompare(b.id);

const bandOrder: readonly InboxBand[] = ["pinned", "needs-you", "running", "unseen", "idle"];

export interface ThreadsPanel {
  /** Every unsettled, unsnoozed thread, band by band (`inboxBand`). */
  inbox: string[];
  /** The pinned threads that lead the Inbox. */
  pinned: string[];
  /** Snoozed threads, the soonest to wake first. */
  snoozed: string[];
  /** Settled threads at rest that are loaded, most recent activity first. */
  settled: string[];
}

export interface PanelInput {
  arrangement: Arrangement;
  entry(id: string): ThreadListEntry | undefined;
  standing(entry: ThreadListEntry): Standing;
  /**
   * How Home sorts (`threads.sortBy`). By live activity (the default) the Inbox goes band by
   * band; Newest first and Manual keep the person's own order below the pinned threads.
   */
  sortBy?: HomeSort | undefined;
}

/**
 * The three places from Home order (`arrange`). A settled thread whose tree still works or asks
 * is not at rest: it is in the Inbox until it rests again. A pinned thread the person settled
 * rests in Settled like any other.
 */
export function threadsPanel(input: PanelInput): ThreadsPanel {
  const { arrangement, entry, standing } = input;
  const byActivity = (input.sortBy ?? "activity") === "activity";
  const pinnedIds = new Set(arrangement.pinned);
  const bands = new Map<InboxBand, { id: string; at: number }[]>(
    bandOrder.map((band) => [band, []]),
  );
  const settled: { id: string; at: number }[] = [];
  const place = (id: string, shown: ThreadListEntry, stands: Standing) => {
    const pinned = pinnedIds.has(id);
    // Sorted another way, everything below the pinned threads keeps the person's order.
    const band = pinned ? "pinned" : byActivity ? inboxBand(stands, false) : "idle";
    bands.get(band)?.push({ id, at: activityOf(shown) });
  };
  for (const id of [...arrangement.pinned, ...arrangement.active, ...arrangement.recent]) {
    const shown = entry(id);
    if (!shown) continue;
    const stands = standing(shown);
    if (pinnedIds.has(id) && isSettled(shown) && atRest(stands)) {
      settled.push({ id, at: activityOf(shown) });
      continue;
    }
    place(id, shown, stands);
  }
  for (const id of arrangement.settled) {
    const shown = entry(id);
    if (!shown) continue;
    const stands = standing(shown);
    // Settled yet its tree still works or asks: in the Inbox, never in Settled.
    if (!atRest(stands)) place(id, shown, stands);
    else settled.push({ id, at: activityOf(shown) });
  }
  const inbox: string[] = [];
  for (const band of bandOrder) {
    const rows = bands.get(band) ?? [];
    // Pinned keep the person's order; by activity each band is newest first; sorted another
    // way, Home order stands.
    const ordered = band === "pinned" || !byActivity ? rows : rows.toSorted(newest);
    for (const row of ordered) inbox.push(row.id);
  }
  return {
    inbox,
    pinned: (bands.get("pinned") ?? []).map((row) => row.id),
    snoozed: arrangement.snoozed.filter((id) => entry(id) !== undefined),
    settled: settled.toSorted(newest).map((row) => row.id),
  };
}
