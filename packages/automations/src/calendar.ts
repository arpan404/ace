export const DAY = 86_400_000;
export const MINUTE = 60_000;
export interface Civil {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}
export function civilStamp(c: Civil): number {
  const d = new Date(0);
  d.setUTCFullYear(c.year, c.month - 1, c.day);
  d.setUTCHours(c.hour, c.minute, 0, 0);
  return d.getTime();
}
export function fromStamp(stamp: number): Civil {
  const d = new Date(stamp);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
  };
}
export function weekday(c: Civil): number {
  return new Date(civilStamp(c)).getUTCDay();
}
export function monthDays(year: number, month: number): number {
  return fromStamp(civilStamp({ year, month: month + 1, day: 1, hour: 0, minute: 0 }) - DAY).day;
}
export function zonedCalendar(timezone: string): {
  local(at: number): Civil;
  resolve(c: Civil): number | undefined;
} {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  });
  const local = (at: number): Civil => {
    const parts = formatter.formatToParts(at);
    const value = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    return {
      year: value("year"),
      month: value("month"),
      day: value("day"),
      hour: value("hour"),
      minute: value("minute"),
    };
  };
  // Probe both sides of transitions, including half-hour changes and date-line jumps.
  const resolve = (c: Civil): number | undefined => {
    const stamp = civilStamp(c);
    let first: number | undefined;
    const offsets = new Set<number>();
    for (const shift of [-2 * DAY, -DAY, 0, DAY, 2 * DAY]) {
      const probe = stamp + shift;
      offsets.add(civilStamp(local(probe)) - probe);
    }
    for (const offset of offsets) {
      const candidate = stamp - offset;
      if (civilStamp(local(candidate)) === stamp && (first === undefined || candidate < first))
        first = candidate;
    }
    return first;
  };
  return { local, resolve };
}
