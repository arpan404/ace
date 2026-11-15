import type { AccountLimits, AccountWindow, UsageLimits } from "./usage-limits.ts";
import { limitTime, roundEstimate } from "./usage-projection.ts";
import { formatCountdown } from "./time.ts";

/*
 * When a limit comes back, said so a row never trades its reset for its run-out: a window that
 * runs out before it resets says both. `strong` marks the rows to read first (out now, or out
 * before the reset at this pace); they stand out by ink, never by colour.
 */

const hour = 3_600_000;

export interface LimitLine {
  /** The first part, in full ink when `strong`: "Out ~10:00 PM", "Resets Wed 8:10 PM". */
  lead: string;
  /** What follows it, quieter: "back 10:10 PM", "in 3h". */
  rest: string | undefined;
  strong: boolean;
  /** The line as a sentence for a screen reader. */
  spoken: string;
}

const line = (lead: string, rest?: string, strong = false, spoken?: string): LimitLine => ({
  lead,
  rest,
  strong,
  spoken: spoken ?? (rest ? `${lead}, ${rest}` : lead),
});

/** A Usage page row's time: when it runs out and is back, is back, or resets. */
export function limitLine(
  window: AccountWindow,
  now: number,
  timeZone?: string,
  locale?: string,
): LimitLine {
  const time = (at: number) => limitTime(at, now, timeZone, locale);
  if (window.stale) return line("Not used since its reset");
  if (window.leftPercent <= 0)
    return window.resetsAt === null
      ? line("Out now", "reset not reported", true)
      : line("Out now", `back ${time(window.resetsAt)}`, true);
  if (window.runsOutAt !== null) {
    const at = time(roundEstimate(window.runsOutAt, now));
    const back = window.resetsAt === null ? undefined : `back ${time(window.resetsAt)}`;
    return line(`Out ~${at}`, back, true, `Runs out around ${at}${back ? `, ${back}` : ""}`);
  }
  if (window.leftPercent >= 100) return line("Fresh");
  if (window.resetsAt === null) return line("Reset not reported");
  const soon = window.resetsAt - now < 24 * hour;
  return line(
    `Resets ${time(window.resetsAt)}`,
    soon ? `in ${formatCountdown(window.resetsAt - now)}` : undefined,
  );
}

/**
 * The rail card's shorter time: a countdown within a day, the weekday further out, and for a
 * window that runs out first, when it's back on a second line.
 */
export function limitCardLine(
  window: AccountWindow,
  now: number,
  timeZone?: string,
  locale?: string,
): LimitLine {
  const time = (at: number) => limitTime(at, now, timeZone, locale);
  if (window.stale) return line("Not used yet", undefined, false, "Not used since its reset");
  if (window.leftPercent <= 0)
    return window.resetsAt === null
      ? line("Out", undefined, true, "Out, reset not reported")
      : line(
          `Back ${time(window.resetsAt)}`,
          undefined,
          true,
          `Out until ${time(window.resetsAt)}`,
        );
  if (window.runsOutAt !== null) {
    const at = time(roundEstimate(window.runsOutAt, now));
    const back = window.resetsAt === null ? undefined : `back ${time(window.resetsAt)}`;
    return line(`Out ~${at}`, back, true, `Runs out around ${at}${back ? `, ${back}` : ""}`);
  }
  if (window.resetsAt === null) return line("");
  if (window.resetsAt - now < 20 * hour)
    return line(`Resets in ${formatCountdown(window.resetsAt - now)}`);
  const weekday = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone }).format(
    window.resetsAt,
  );
  return line(`Resets ${weekday}`, undefined, false, `Resets ${time(window.resetsAt)}`);
}

/** One thing about to change on the Usage page: a window running out, or one coming back. */
export interface ComingUp {
  key: string;
  at: number;
  /** "~9:20 PM" for an estimate, "9:37 PM" for a reported reset. */
  time: string;
  /** "Codex · Team weekly runs out". */
  what: string;
  /** "back Fri 8:10 PM", "in 1h 27m". */
  after: string | undefined;
  entry: AccountLimits;
  /** The account's banked resets, when it has some to spend on this. */
  banked: number | undefined;
}

/** "session" for the 5-hour window, else its label as it reads mid-sentence: "weekly · Fable". */
const windowName = (label: string) =>
  label === "Session (5h)" ? "session" : label.charAt(0).toLowerCase() + label.slice(1);

/**
 * What changes next across every account, soonest first: windows that run out before they reset
 * at this pace, with when they're back, and windows that are out, with when they come back.
 */
export function comingUp(
  limits: UsageLimits,
  now: number,
  timeZone?: string,
  locale?: string,
  most = 6,
): ComingUp[] {
  const time = (at: number) => limitTime(at, now, timeZone, locale);
  const events: ComingUp[] = [];
  for (const group of limits.providers)
    for (const entry of group.accounts) {
      if (entry.signIn) continue;
      const name = `${group.providerLabel} · ${entry.account.label}`;
      const banked =
        entry.bankedResets !== undefined && entry.bankedResets > 0 ? entry.bankedResets : undefined;
      for (const window of entry.windows) {
        if (window.stale) continue;
        const key = `${entry.key}:${window.id}`;
        if (window.leftPercent <= 0 && window.resetsAt !== null && window.resetsAt > now)
          events.push({
            key,
            at: window.resetsAt,
            time: time(window.resetsAt),
            what: `${name} ${windowName(window.label)} is back`,
            after: `in ${formatCountdown(window.resetsAt - now)}`,
            entry,
            banked,
          });
        else if (window.leftPercent > 0 && window.runsOutAt !== null) {
          const at = roundEstimate(window.runsOutAt, now);
          events.push({
            key,
            at,
            time: `~${time(at)}`,
            what: `${name} ${windowName(window.label)} runs out`,
            after: window.resetsAt === null ? undefined : `back ${time(window.resetsAt)}`,
            entry,
            banked,
          });
        }
      }
    }
  return events.toSorted((a, b) => a.at - b.at).slice(0, most);
}
