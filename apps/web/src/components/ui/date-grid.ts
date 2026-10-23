/*
 * Calendar dates as "YYYY-MM-DD" keys, with no time or zone: the date pickers' arithmetic. Keys
 * compare correctly as strings. Pure.
 */

export type DateKey = string;

const pad = (value: number) => String(value).padStart(2, "0");
const DAY = 86_400_000;

export function dateKey(year: number, month: number, day: number): DateKey {
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** Year, month (1–12) and day of a key; undefined when it isn't a real date. */
export function readDateKey(key: string): { year: number; month: number; day: number } | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) return undefined;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const at = new Date(Date.UTC(year, month - 1, day));
  return at.getUTCMonth() === month - 1 && at.getUTCDate() === day
    ? { year, month, day }
    : undefined;
}

const toUtc = (key: DateKey) => {
  const date = readDateKey(key);
  return date ? Date.UTC(date.year, date.month - 1, date.day) : Number.NaN;
};
const fromUtc = (at: number): DateKey => {
  const date = new Date(at);
  return dateKey(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
};

export function addDays(key: DateKey, days: number): DateKey {
  return fromUtc(toUtc(key) + days * DAY);
}

/** The same day in a month `months` away, clamped to that month's last day. */
export function addMonths(key: DateKey, months: number): DateKey {
  const date = readDateKey(key);
  if (!date) return key;
  const first = new Date(Date.UTC(date.year, date.month - 1 + months, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return dateKey(first.getUTCFullYear(), first.getUTCMonth() + 1, Math.min(date.day, last));
}

/** The first of the key's month. */
export const monthOf = (key: DateKey): DateKey => `${key.slice(0, 7)}-01`;

/**
 * Six weeks, Sunday first, that cover the month of `month` (any day in it): what a calendar
 * shows, with the days outside the month marked.
 */
export function monthGrid(month: DateKey): { key: DateKey; inMonth: boolean }[] {
  const first = monthOf(month);
  const start = addDays(first, -new Date(toUtc(first)).getUTCDay());
  return Array.from({ length: 42 }, (_, index) => {
    const key = addDays(start, index);
    return { key, inMonth: key.slice(0, 7) === first.slice(0, 7) };
  });
}

/** "October 2026". */
export function monthLabel(month: DateKey): string {
  return new Date(toUtc(month)).toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "long",
    year: "numeric",
  });
}

/** "Today", "Tomorrow", "Oct 24", or "Oct 24, 2027" in another year: how a picked date reads. */
export function dateLabel(key: DateKey, today: DateKey): string {
  if (key === today) return "Today";
  if (key === addDays(today, 1)) return "Tomorrow";
  return new Date(toUtc(key)).toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    ...(key.slice(0, 4) === today.slice(0, 4) ? {} : { year: "numeric" }),
  });
}
