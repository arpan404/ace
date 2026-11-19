import { snoozedPullRequests, threadLive } from "@ace/projection";
import type { ThreadListEntry } from "@ace/protocol";
import { formatClock } from "./time.ts";
export interface SnoozePreset {
  id: "hour" | "tomorrow" | "monday";
  label: string;
  /** When it wakes, for the menu's right column. */
  detail: string;
  until: number;
}

const time = (at: Date, locale?: string) => formatClock(at.getTime(), locale);

function atNine(from: Date, daysAhead: number): Date {
  const next = new Date(from);
  next.setDate(next.getDate() + daysAhead);
  next.setHours(9, 0, 0, 0);
  return next;
}

/** One hour, tomorrow 9:00 and next Monday 9:00, in local time. Pure: the caller gives now. */
export function snoozePresets(now: number, locale?: string): SnoozePreset[] {
  const today = new Date(now);
  const hour = new Date(now + 60 * 60 * 1000);
  const tomorrow = atNine(today, 1);
  // Days until the next Monday, never today: Sunday → 1, Monday → 7.
  const monday = atNine(today, (8 - today.getDay()) % 7 || 7);
  return [
    { id: "hour", label: "1 hour", detail: time(hour, locale), until: hour.getTime() },
    {
      id: "tomorrow",
      label: "Tomorrow",
      detail: time(tomorrow, locale),
      until: tomorrow.getTime(),
    },
    {
      id: "monday",
      label: "Next Monday",
      detail: monday.toLocaleDateString(locale, { month: "short", day: "numeric" }),
      until: monday.getTime(),
    },
  ];
}

/** "Tomorrow 9:00 AM", "Mon 9:00 AM", "Oct 14, 9:00 AM": when a snoozed thread wakes. */
export function describeWake(until: number, now: number, locale?: string): string {
  const at = new Date(until);
  const today = new Date(now);
  const days = Math.round(
    (new Date(at).setHours(0, 0, 0, 0) - new Date(today).setHours(0, 0, 0, 0)) / 86_400_000,
  );
  if (days <= 0) return time(at, locale);
  if (days === 1) return `tomorrow ${time(at, locale)}`;
  if (days < 7) return `${at.toLocaleDateString(locale, { weekday: "short" })} ${time(at, locale)}`;
  return `${at.toLocaleDateString(locale, { month: "short", day: "numeric" })}, ${time(at, locale)}`;
}

/**
 * A snooze that ends on an event still ends at this time if the event never comes, so nothing
 * sleeps for good: 30 days.
 */
export const eventSnoozeBackstopMs = 30 * 86_400_000;

/** The snoozes that end on an event, as menus offer them. */
export interface EventSnooze {
  wake: "needs_you" | "pr";
  label: string;
  /** What brings it back, under the label. */
  detail: string;
}

/**
 * The event snoozes that fit a thread: "Until it needs you" while it works or waits (its whole
 * tree counted), "Until the PR changes" while it has a pull request the forge has confirmed.
 */
export function eventSnoozes(
  entry: Pick<ThreadListEntry, "status" | "queue" | "details">,
): EventSnooze[] {
  const choices: EventSnooze[] = [];
  if (threadLive(entry))
    choices.push({
      wake: "needs_you",
      label: "Until it needs you",
      detail: "Returns on a question, a failure or when it finishes",
    });
  if (snoozedPullRequests(entry.details).length)
    choices.push({
      wake: "pr",
      label: "Until the PR changes",
      detail: "A review, a push or checks finishing",
    });
  return choices;
}

/** What a snoozed row says where its status sits: "until it needs you", "until Mon 9:00 AM". */
export function snoozeLabel(
  entry: Pick<ThreadListEntry, "snoozedUntil" | "snoozeWake">,
  now: number,
  locale?: string,
): string | undefined {
  if (entry.snoozeWake?.on === "needs_you") return "until it needs you";
  if (entry.snoozeWake?.on === "pr") return "until the PR changes";
  return entry.snoozedUntil === undefined
    ? undefined
    : `until ${describeWake(entry.snoozedUntil, now, locale)}`;
}
