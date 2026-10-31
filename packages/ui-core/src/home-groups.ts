import type { CatalogModel, ThreadListEntry } from "@ace/protocol";
import { threadCard } from "./thread-card.ts";
import { activityOf } from "./thread-state.ts";

/*
 * The Threads panel's groups. The Active tab splits the threads below Pinned into what needs the
 * person, what is running, and then the rest by the day of their last activity; the Settled tab
 * splits settled threads by week, then by month. A thread's lane comes from the same attention
 * rule every row reads (`threadCard` → `rowAttention`), so a group never disagrees with the
 * row's own status word. Pure: the caller passes the clock.
 */

/** Where an active thread stands: asking the person, at work, or at rest. */
export type HomeLane = "needs-you" | "running" | "rest";

export interface LaneInput {
  /** Activity before this moment counts as seen (the organizer's first-launch baseline). */
  baseline: number;
  now: number;
  models?: readonly CatalogModel[] | undefined;
}

/**
 * The lane of a listed thread, from its row attention: a request, a recovery the person must act
 * on or an unseen failure needs them; working, waiting and background work is running, its
 * whole agent tree included (a root whose subagents still run reads as running); everything
 * else (done, seen failures, new) is at rest and lands by day.
 */
export function homeLane(entry: ThreadListEntry, input: LaneInput): HomeLane {
  const card = threadCard({
    entry,
    baseline: input.baseline,
    now: input.now,
    settled: false,
    models: input.models,
  });
  const { level } = card.attention;
  if (level === "needs-you" || level === "failed") return "needs-you";
  if (level === "active") return "running";
  return "rest";
}

/** The Active tab's groups below Pinned, top to bottom. */
export const activeGroupKeys = [
  "needs-you",
  "running",
  "today",
  "yesterday",
  "week",
  "earlier",
] as const;
export type ActiveGroupKey = (typeof activeGroupKeys)[number];

export const activeGroupLabels: Record<ActiveGroupKey, string> = {
  "needs-you": "Needs you",
  running: "Running",
  today: "Today",
  yesterday: "Yesterday",
  week: "This week",
  earlier: "Earlier",
};

/** Local midnight at the start of `at`'s day. */
function startOfDay(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Local midnight on the Monday of `at`'s week. */
function startOfWeek(at: number): number {
  const date = new Date(startOfDay(at));
  // Sunday is 0: weeks start on Monday.
  const back = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - back);
  return date.getTime();
}

/** Midnight a whole number of calendar days before `midnight` (DST-safe). */
function daysBefore(midnight: number, days: number): number {
  const date = new Date(midnight);
  date.setDate(date.getDate() - days);
  return date.getTime();
}

/**
 * The day group of a thread at rest, by its last activity: Today, Yesterday, This week (since
 * Monday), then Earlier. Activity a moment ahead of the clock counts as today.
 */
export function dayGroupOf(at: number, now: number): Exclude<ActiveGroupKey, "needs-you" | "running"> {
  const today = startOfDay(now);
  if (at >= today) return "today";
  if (at >= daysBefore(today, 1)) return "yesterday";
  if (at >= startOfWeek(now)) return "week";
  return "earlier";
}

export type ActiveGroups = Record<ActiveGroupKey, string[]>;

/**
 * The threads below Pinned, already in Home order, split into the Active tab's groups. Each
 * group keeps the order it was given. `lane` reads a thread's lane (`homeLane`, or a cached copy
 * of it); `at` its last activity.
 */
export function activeGroups(
  entries: readonly ThreadListEntry[],
  lane: (entry: ThreadListEntry) => HomeLane,
  now: number,
): ActiveGroups {
  const groups: ActiveGroups = {
    "needs-you": [],
    running: [],
    today: [],
    yesterday: [],
    week: [],
    earlier: [],
  };
  for (const entry of entries) {
    const stands = lane(entry);
    const key = stands === "rest" ? dayGroupOf(activityOf(entry), now) : stands;
    groups[key].push(entry.id);
  }
  return groups;
}

const monthNames = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/**
 * The Settled tab's group for a thread settled into the list at `at`: This week (since Monday),
 * Last week, then the month ("October"), with its year once it is another year's ("December
 * 2025"). The key is stable while the label is the same.
 */
export function weekGroupOf(at: number, now: number): { key: string; label: string } {
  const week = startOfWeek(now);
  if (at >= week) return { key: "this-week", label: "This week" };
  if (at >= daysBefore(week, 7)) return { key: "last-week", label: "Last week" };
  const date = new Date(at);
  const year = date.getFullYear();
  const month = date.getMonth();
  const name = monthNames[month] ?? "";
  const label = year === new Date(now).getFullYear() ? name : `${name} ${year}`;
  return { key: `${year}-${month}`, label };
}
