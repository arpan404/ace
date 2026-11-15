import type { LimitChange } from "./limits.ts";
import { accountName } from "./limits.ts";
import { formatClock, formatCountdown } from "./time.ts";

/*
 * The words for a usage window's reset and for an account crossing its limit, shared by the web's
 * toasts and the phone's notifications.
 */

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
 * not reported" when the provider didn't say. A passed reset awaits a new provider reading;
 * rereading cached accounts does not refresh the window.
 */
export function resetParts(at: number | null, now: number, locale?: string): string[] {
  if (at === null) return ["Reset time not reported"];
  if (at <= now) return ["Reset time passed", "waiting for a new provider reading"];
  return [formatResets(at, now, locale), `in ${formatCountdown(at - now)}`];
}

/** "Resets 15:20 · in 1h 27m": `resetParts` on one line. */
export function formatResetCountdown(at: number | null, now: number, locale?: string): string {
  return resetParts(at, now, locale).join(" · ");
}

/** What an account crossing its limit says: near it, reached, or able to work again. */
export function limitAlertWords(
  change: LimitChange,
  now: number,
  locale?: string,
): { title: string; description: string } {
  const name = accountName(change.account);
  switch (change.kind) {
    case "near":
      return {
        title: `${name} is near its usage limit`,
        description: `${change.window.usedPercent}% of the ${change.window.label} window used. ${formatResetCountdown(change.window.resetsAt, now, locale)}.`,
      };
    case "reached":
      return {
        title: `${name} reached its usage limit`,
        description:
          change.resetsAt === undefined
            ? "The provider didn't say when it resets."
            : `${formatResetCountdown(change.resetsAt, now, locale)}.`,
      };
    case "reset":
      return { title: `${name} can work again`, description: "Its usage window has reset." };
  }
}
