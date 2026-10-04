import { LruCache } from "./lru.ts";

/*
 * Usage is counted in calendar days of the daemon's time zone (every usage reply names it), not
 * the device's. Days step back on the calendar, so a range keeps its length across DST changes.
 */

const formats = new LruCache<string, Intl.DateTimeFormat>({ maxEntries: 8 });

function format(timeZone: string | undefined): Intl.DateTimeFormat {
  const key = timeZone ?? "";
  let formatter = formats.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formats.set(key, formatter);
  }
  return formatter;
}

/** The wall clock at `at` in `timeZone`, as if it were UTC. */
function wallClock(at: number, timeZone: string | undefined): number {
  const parts: Partial<Record<Intl.DateTimeFormatPartTypes, number>> = {};
  for (const part of format(timeZone).formatToParts(at))
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  return Date.UTC(
    parts.year ?? 1970,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0,
  );
}

const isoDate = (utc: number) => new Date(utc).toISOString().slice(0, 10);

/** `timeZone` when the platform knows it, else undefined (the device's own zone). */
export function knownTimeZone(timeZone: string | undefined): string | undefined {
  if (!timeZone) return undefined;
  try {
    format(timeZone);
    return timeZone;
  } catch {
    return undefined;
  }
}

/** The calendar day `days` before `now` in `timeZone`, as YYYY-MM-DD (usage queries' days). */
export function usageDay(now: number, timeZone: string | undefined, days = 0): string {
  const wall = new Date(wallClock(now, timeZone));
  return isoDate(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate() - days));
}

/** The instant the calendar day `day` (YYYY-MM-DD) begins in `timeZone`. */
export function dayStart(day: string, timeZone: string | undefined): number {
  const midnight = Date.parse(`${day}T00:00:00Z`);
  const offset = (at: number) => wallClock(at, timeZone) - Math.floor(at / 1000) * 1000;
  // The zone's offset at midnight may differ from the offset at the first guess (a DST change).
  const guess = midnight - offset(midnight);
  return midnight - offset(guess);
}
