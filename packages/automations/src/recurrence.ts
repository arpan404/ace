import { z } from "zod";
import { AutomationSchedule } from "@ace/protocol";
import {
  DAY,
  MINUTE,
  civilStamp,
  fromStamp,
  weekday,
  monthDays,
  zonedCalendar,
  type Civil,
} from "./calendar.ts";
import { cronField, parseRule, type Rule } from "./grammar.ts";

export const Occurrence = z.object({
  at: z.number().int().nonnegative(),
  ordinal: z.number().int().min(1).max(1_000_000),
});
export type Occurrence = z.infer<typeof Occurrence>;
export interface Recurrence {
  next(after: number): number | undefined;
  /** A persisted cursor makes COUNT advancement proportional to new occurrences. */
  seek(after: number, previous?: Occurrence): Occurrence | undefined;
}
function ruleDay(rule: Rule, day: Civil, anchor: Civil): boolean {
  const stamp = civilStamp(day),
    origin = civilStamp({ ...anchor, hour: 0, minute: 0 });
  const delta = Math.round((stamp - origin) / DAY);
  const dow = weekday(day);
  const monthDelta = (day.year - anchor.year) * 12 + day.month - anchor.month;
  switch (rule.frequency) {
    case "DAILY":
      if (delta % rule.interval !== 0) return false;
      break;
    case "WEEKLY": {
      const monday = origin - ((weekday(anchor) + 6) % 7) * DAY;
      if (Math.floor((stamp - monday) / (7 * DAY)) % rule.interval !== 0) return false;
      if (!rule.days && dow !== weekday(anchor)) return false;
      break;
    }
    case "MONTHLY":
      if (monthDelta % rule.interval !== 0 || (!rule.days && day.day !== anchor.day)) return false;
      break;
    case "YEARLY":
      if (
        (day.year - anchor.year) % rule.interval !== 0 ||
        (!rule.days && (day.month !== anchor.month || day.day !== anchor.day))
      )
        return false;
      break;
    default:
      break;
  }
  if (!rule.days) return true;
  return rule.days.some((filter) => {
    if (dow !== filter.weekday) return false;
    if (filter.ordinal === undefined) return true;
    const start =
      rule.frequency === "YEARLY"
        ? civilStamp({ ...day, month: 1, day: 1 })
        : civilStamp({ ...day, day: 1 });
    const total =
      rule.frequency === "YEARLY"
        ? (civilStamp({ ...day, year: day.year + 1, month: 1, day: 1 }) - start) / DAY
        : monthDays(day.year, day.month);
    const index = (stamp - start) / DAY;
    return filter.ordinal > 0
      ? Math.floor(index / 7) + 1 === filter.ordinal
      : -(Math.floor((total - index - 1) / 7) + 1) === filter.ordinal;
  });
}
export function compileSchedule(input: unknown): Recurrence {
  const schedule = AutomationSchedule.parse(input);
  const calendar = zonedCalendar(schedule.timezone);
  const anchor = calendar.local(schedule.startAt);
  const anchorStamp = civilStamp(anchor);
  const rule = schedule.kind === "rrule" ? parseRule(schedule.expression) : undefined;
  let minutes: number[], hours: number[], matchesDay: (day: Civil) => boolean;
  if (rule) {
    hours =
      rule.hours ??
      (["HOURLY", "MINUTELY"].includes(rule.frequency)
        ? Array.from({ length: 24 }, (_, i) => i)
        : [anchor.hour]);
    minutes =
      rule.minutes ??
      (rule.frequency === "MINUTELY" ? Array.from({ length: 60 }, (_, i) => i) : [anchor.minute]);
    matchesDay = (day) => ruleDay(rule, day, anchor);
  } else {
    const fields = schedule.expression.trim().split(/\s+/);
    if (fields.length !== 5) throw new Error("Cron requires five fields");
    const [m, h, d, mo, w] = fields;
    minutes = cronField(m ?? "", 0, 59);
    hours = cronField(h ?? "", 0, 23);
    const days = new Set(cronField(d ?? "", 1, 31)),
      months = new Set(cronField(mo ?? "", 1, 12)),
      weeks = new Set(cronField(w ?? "", 0, 7).map((n) => n % 7));
    const dayWildcard = d?.startsWith("*") ?? false,
      weekWildcard = w?.startsWith("*") ?? false;
    matchesDay = (day) =>
      months.has(day.month) &&
      (dayWildcard || weekWildcard
        ? days.has(day.day) && weeks.has(weekday(day))
        : days.has(day.day) || weeks.has(weekday(day)));
  }
  const seek = (after: number, previous?: Occurrence): Occurrence | undefined => {
    if (!Number.isSafeInteger(after)) throw new Error("Invalid recurrence cursor");
    if (rule?.until !== undefined && after >= rule.until) return undefined;
    if (rule && after < schedule.startAt)
      return schedule.startAt <= (rule.until ?? Infinity)
        ? { at: schedule.startAt, ordinal: 1 }
        : undefined;
    const cursor =
      rule?.count !== undefined && previous !== undefined ? Occurrence.parse(previous) : undefined;
    if (cursor && (cursor.at > after || cursor.at < schedule.startAt))
      throw new Error("Invalid counted cursor");
    let count = cursor?.ordinal ?? (rule ? 1 : 0); // DTSTART is always the first RRULE occurrence.
    if (rule?.count !== undefined && count >= rule.count) return undefined;
    const first =
      rule?.count !== undefined
        ? cursor
          ? calendar.local(cursor.at)
          : anchor
        : calendar.local(Math.max(after, schedule.startAt));
    let date = civilStamp({ ...first, hour: 0, minute: 0 });
    const lower =
      rule?.count !== undefined
        ? cursor
          ? civilStamp(calendar.local(cursor.at)) + MINUTE
          : anchorStamp
        : civilStamp(calendar.local(Math.max(after, schedule.startAt - 1)));
    let work = 0;
    for (let days = 0; days < 146_097; days++, date += DAY) {
      const day = fromStamp(date);
      if (!matchesDay(day)) continue;
      for (const hour of hours)
        for (const minute of minutes) {
          const candidate = date + hour * 60 * MINUTE + minute * MINUTE;
          if (candidate < anchorStamp || candidate < lower || (rule && candidate === anchorStamp))
            continue;
          if (
            rule?.frequency === "HOURLY" &&
            Math.floor((candidate - anchorStamp) / (60 * MINUTE)) % rule.interval !== 0
          )
            continue;
          if (
            rule?.frequency === "MINUTELY" &&
            ((candidate - anchorStamp) / MINUTE) % rule.interval !== 0
          )
            continue;
          if (++work > 1_000_000) throw new Error("Recurrence evaluation budget exhausted");
          const at = calendar.resolve({ ...day, hour, minute });
          if (at === undefined || at < schedule.startAt) continue;
          if (rule?.until !== undefined && at > rule.until) return undefined;
          count++;
          if (rule?.count !== undefined && count > rule.count) return undefined;
          if (at > after) return { at, ordinal: count };
        }
    }
    throw new Error("Recurrence search horizon exhausted");
  };
  return { seek, next: (after) => seek(after)?.at };
}
export function nextOccurrence(schedule: AutomationSchedule, after: number): number | undefined {
  return compileSchedule(schedule).next(after);
}
