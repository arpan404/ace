import { formatClock } from "./time.ts";

/*
 * When a limit resets or runs out, in words a row can say: a clock time today, the weekday
 * further out. A run-out is an estimate from the pace so far, so it is rounded.
 */

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

/** "16:50" within the next 20 hours; "Thu 15:00" further out. */
export function limitTime(at: number, now: number, timeZone?: string, locale?: string): string {
  const clock = formatClock(at, locale, timeZone);
  if (at - now < 20 * hour) return clock;
  return `${new Intl.DateTimeFormat(locale, { weekday: "short", timeZone }).format(at)} ${clock}`;
}

/** A projection is an estimate: rounded to 5 minutes within a day, else to the hour. */
export function roundEstimate(at: number, now: number): number {
  const step = at - now < day ? 5 * minute : hour;
  return Math.round(at / step) * step;
}
