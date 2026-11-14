import type { AccountWindow } from "./usage-limits.ts";
import { formatAgo, formatClock, formatCountdown } from "./time.ts";

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

/**
 * "09:12" within the last 20 hours; "4 Nov, 15:03" further back, by date, so a week's start never
 * reads as the same weekday as its reset.
 */
function pastTime(at: number, now: number, timeZone?: string, locale?: string): string {
  const clock = formatClock(at, locale, timeZone);
  if (now - at < 20 * hour) return clock;
  const date = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", timeZone });
  return `${date.format(at)}, ${clock}`;
}

/** A projection is an estimate: rounded to 5 minutes within a day, else to the hour. */
export function roundEstimate(at: number, now: number): number {
  const step = at - now < day ? 5 * minute : hour;
  return Math.round(at / step) * step;
}

/** One line of a limit's hover card: what it is, its value, and whether it warns. */
export interface LimitDetail {
  label: string;
  value: string;
  tone?: "out" | undefined;
}

/**
 * Everything a limit's row leaves out, line by line: what is left and used, where its pace leads,
 * how that pace compares with an even one, when it resets and began, and how old the reading is.
 */
export function limitDetails(
  window: AccountWindow,
  now: number,
  timeZone?: string,
  locale?: string,
): LimitDetail[] {
  const time = (at: number) => limitTime(at, now, timeZone, locale);
  if (window.stale)
    return [
      { label: "Now", value: "Not used since its reset" },
      ...(window.resetsAt === null
        ? []
        : [{ label: "Reset", value: formatAgo(window.resetsAt, now) }]),
      { label: "Read", value: formatAgo(window.observedAt, now) },
    ];
  const used = 100 - window.leftPercent;
  const lines: LimitDetail[] = [
    { label: "Now", value: `${window.leftPercent}% left · ${used}% used` },
  ];
  if (window.leftPercent <= 0) lines.push({ label: "At this pace", value: "Out", tone: "out" });
  else if (window.runsOutAt !== null)
    lines.push({
      label: "At this pace",
      value: `Runs out around ${time(roundEstimate(window.runsOutAt, now))}`,
      tone: "out",
    });
  else if (window.leftAtReset !== null)
    lines.push({ label: "At this pace", value: `About ${window.leftAtReset}% left at the reset` });
  if (window.pace)
    lines.push({
      label: "Pace",
      value:
        window.pace === "ahead"
          ? "Faster than the window runs"
          : window.pace === "behind"
            ? "Slower than the window runs"
            : "About even with the window",
    });
  if (window.resetsAt !== null)
    lines.push({
      label: "Resets",
      value: `${time(window.resetsAt)} · in ${formatCountdown(window.resetsAt - now)}`,
    });
  if (window.startsAt !== null && window.startsAt <= now)
    lines.push({ label: "Began", value: pastTime(window.startsAt, now, timeZone, locale) });
  lines.push({ label: "Read", value: formatAgo(window.observedAt, now) });
  return lines;
}

/** What a limit's row says at its right, the words a screen reader hears, and whether it warns. */
export interface LimitWhen {
  text: string;
  spoken: string;
  /** Out, or running out before its reset at this pace: the row turns red. */
  runsOut: boolean;
}

/**
 * When a window runs out, is out until, or resets. A run-out before the reset is an estimate, so
 * the row keeps it to "Out around Sun 9:00 PM" and the spoken words say the sentence in full.
 */
export function limitWhen(
  window: AccountWindow,
  now: number,
  timeZone?: string,
  locale?: string,
): LimitWhen {
  const time = (at: number) => limitTime(at, now, timeZone, locale);
  const plain = (text: string, runsOut = false) => ({ text, spoken: text, runsOut });
  if (window.stale) return plain("Not used since its reset");
  if (window.leftPercent <= 0)
    return plain(
      window.resetsAt === null ? "Out, reset not reported" : `Out until ${time(window.resetsAt)}`,
      true,
    );
  if (window.runsOutAt !== null) {
    const at = time(roundEstimate(window.runsOutAt, now));
    return { text: `Out around ${at}`, spoken: `Runs out around ${at}`, runsOut: true };
  }
  if (window.leftPercent >= 100) return plain("Fresh");
  if (window.resetsAt === null) return plain("Reset not reported");
  return plain(`Resets ${time(window.resetsAt)}`);
}
