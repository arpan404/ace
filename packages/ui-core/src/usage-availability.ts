import type { AccountLimits, AccountWindow } from "./usage-limits.ts";
import { formatClock } from "./time.ts";

/*
 * Limits as availability: one shared timeline from now to a week out, the next five hours drawn
 * wide and the rest of the week compressed, and each account's stretches on it, usable or out.
 * An account is out from when a window runs out (now, if it already has; else when the pace so
 * far reaches 100%) until that window resets. Stretches only project the windows reported now;
 * nothing past a reset is guessed.
 */

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

export interface AvailabilityAxis {
  from: number;
  /** The end of the detailed part: five hours out. */
  detailUntil: number;
  to: number;
  /** The share of the width the detailed part takes. */
  detailShare: number;
}

export function availabilityAxis(now: number): AvailabilityAxis {
  return { from: now, detailUntil: now + 5 * hour, to: now + 7 * day, detailShare: 0.3 };
}

/** Where a time sits on the axis, 0–100; clamped to its ends. */
export function axisPercent(axis: AvailabilityAxis, at: number): number {
  const t = Math.min(axis.to, Math.max(axis.from, at));
  const share =
    t <= axis.detailUntil
      ? ((t - axis.from) / (axis.detailUntil - axis.from)) * axis.detailShare
      : axis.detailShare +
        ((t - axis.detailUntil) / (axis.to - axis.detailUntil)) * (1 - axis.detailShare);
  return Math.round(share * 10_000) / 100;
}

export interface AvailabilityStretch {
  from: number;
  to: number;
  out: boolean;
}

/** A time the account can't work: from when a window is out until it resets. */
export interface Lockout {
  window: AccountWindow;
  from: number;
  /** Null when the provider reports no reset. */
  until: number | null;
  /** True when it's out already; false when the pace so far leads there. */
  now: boolean;
}

export interface AccountAvailability {
  stretches: AvailabilityStretch[];
  /** The soonest time it is out, merged with any that overlap it. */
  lockout: Lockout | undefined;
  /** The one after it, on the timeline: a session out now, and a week that runs out later. */
  nextLockout: Lockout | undefined;
  /** With no lockout: the window that resets with the least to spare, and how much. */
  tightest: { window: AccountWindow; sparePercent: number } | undefined;
  /** Every window's reading is older than its reset: what's left now isn't known. */
  unknown: boolean;
}

/** The share left when a window resets, if use carries on at its pace so far. */
export function spareAtReset(window: AccountWindow, now: number): number | undefined {
  if (window.startsAt === null || window.resetsAt === null) return undefined;
  const ran = now - window.startsAt;
  if (ran <= 0) return window.leftPercent;
  const used = 100 - window.leftPercent;
  const atReset = used + (used / ran) * (window.resetsAt - now);
  return Math.max(0, Math.round(100 - atReset));
}

export function accountAvailability(
  entry: AccountLimits,
  axis: AvailabilityAxis,
): AccountAvailability {
  const now = axis.from;
  const live = entry.windows.filter((window) => !window.stale);
  const outs = live.flatMap((window): Lockout[] => {
    if (window.leftPercent <= 0) return [{ window, from: now, until: window.resetsAt, now: true }];
    if (window.runsOutAt === null) return [];
    return [{ window, from: window.runsOutAt, until: window.resetsAt, now: false }];
  });
  const merged = mergeLockouts(outs.toSorted((a, b) => a.from - b.from));
  const stretches: AvailabilityStretch[] = [];
  let cursor = now;
  for (const lockout of merged) {
    if (lockout.from >= axis.to) break;
    if (lockout.from > cursor) stretches.push({ from: cursor, to: lockout.from, out: false });
    const end = Math.min(axis.to, lockout.until ?? axis.to);
    stretches.push({ from: Math.max(cursor, lockout.from), to: end, out: true });
    cursor = end;
  }
  if (cursor < axis.to && live.length) stretches.push({ from: cursor, to: axis.to, out: false });
  const lockout = merged[0];
  const nextLockout = merged[1] && merged[1].from < axis.to ? merged[1] : undefined;
  let tightest: AccountAvailability["tightest"];
  if (!lockout)
    for (const window of live) {
      const spare = spareAtReset(window, now);
      if (spare !== undefined && (!tightest || spare < tightest.sparePercent))
        tightest = { window, sparePercent: spare };
    }
  return {
    stretches,
    lockout,
    nextLockout,
    tightest,
    unknown: entry.windows.length > 0 && live.length === 0,
  };
}

/** Overlapping lockouts become one, named by the window that starts it, until the last reset. */
function mergeLockouts(sorted: readonly Lockout[]): Lockout[] {
  const merged: Lockout[] = [];
  for (const each of sorted) {
    const last = merged.at(-1);
    if (last && (last.until === null || each.from <= last.until)) {
      const until =
        last.until === null || each.until === null ? null : Math.max(last.until, each.until);
      merged[merged.length - 1] = { ...last, until };
    } else merged.push(each);
  }
  return merged;
}

/** "16:50" within the next 20 hours; "Thu 15:00" further out. */
export function availabilityTime(
  at: number,
  now: number,
  timeZone?: string,
  locale?: string,
): string {
  const clock = formatClock(at, locale, timeZone);
  if (at - now < 20 * hour) return clock;
  return `${new Intl.DateTimeFormat(locale, { weekday: "short", timeZone }).format(at)} ${clock}`;
}

/** A projection is an estimate: rounded to 5 minutes within a day, else to the hour. */
export function roundEstimate(at: number, now: number): number {
  const step = at - now < day ? 5 * minute : hour;
  return Math.round(at / step) * step;
}

/** "session", "week", or the window's own label for any other. */
export function windowNoun(window: AccountWindow): string {
  if (window.label === "Session (5h)") return "session";
  if (window.label === "Weekly") return "week";
  if (window.label === "Daily") return "day";
  return window.label;
}

/** The window named at the start of a sentence: "Session", "Weekly", "Weekly · Fable". */
const windowName = (window: AccountWindow) =>
  window.label === "Session (5h)" ? "Session" : window.label;

function lockoutWords(lockout: Lockout, now: number, time: (at: number) => string): string {
  const back = lockout.until === null ? "reset not reported" : `back ${time(lockout.until)}`;
  if (lockout.now) return `${windowName(lockout.window)} is out, ${back}`;
  return `${windowName(lockout.window)} runs out around ${time(roundEstimate(lockout.from, now))}, ${back}`;
}

/**
 * The account's availability in one sentence: when it is out and back, or that it lasts and with
 * how much to spare. `tone` says whether it is out now, will be, or is fine.
 */
export function availabilitySentence(
  availability: AccountAvailability,
  now: number,
  timeZone?: string,
  locale?: string,
): { text: string; tone: "out" | "low" | "ok" } {
  const time = (at: number) => availabilityTime(at, now, timeZone, locale);
  const { lockout, tightest } = availability;
  if (availability.unknown) return { text: "Not used since its last reset", tone: "ok" };
  if (lockout) {
    const first = lockoutWords(lockout, now, time);
    const next = availability.nextLockout && lockoutWords(availability.nextLockout, now, time);
    return { text: next ? `${first}. ${next}` : first, tone: lockout.now ? "out" : "low" };
  }
  if (tightest && tightest.window.resetsAt !== null)
    return {
      text: `Lasts, about ${tightest.sparePercent}% to spare at ${time(tightest.window.resetsAt)}`,
      tone: "ok",
    };
  return { text: "Lasts at this pace", tone: "ok" };
}
