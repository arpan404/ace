import { formatClock, formatCountdown } from "@ace/ui-core";

const hour = 3_600_000;

/** "Resets 15:20" within a day, "Resets Monday" within a week, else the date. */
export function formatResets(at: number, now: number, locale?: string): string {
  if (at - now < 20 * hour) return `Resets ${formatClock(at, locale)}`;
  if (at - now < 7 * 24 * hour)
    return `Resets ${new Intl.DateTimeFormat(locale, { weekday: "long" }).format(at)}`;
  return `Resets ${new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(at)}`;
}

/**
 * ["Resets 15:20", "in 1h 27m"]: when a window resets and how long until then; just "Reset time
 * not reported" when the provider didn't say, "Resets now" once the moment has passed (the next
 * read brings the fresh window).
 */
export function resetParts(at: number | null, now: number, locale?: string): string[] {
  if (at === null) return ["Reset time not reported"];
  if (at <= now) return ["Resets now"];
  return [formatResets(at, now, locale), `in ${formatCountdown(at - now)}`];
}

/** "Resets 15:20 · in 1h 27m": `resetParts` on one line. */
export function formatResetCountdown(at: number | null, now: number, locale?: string): string {
  return resetParts(at, now, locale).join(" · ");
}

export { formatClock } from "@ace/ui-core";
