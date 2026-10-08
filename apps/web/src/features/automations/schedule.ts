import { formatClock } from "@ace/ui-core";
import { civilStamp, zonedCalendar } from "@ace/automations/calendar";
import { compileSchedule } from "@ace/automations/recurrence";
import type { AutomationSchedule, AutomationTrigger } from "@ace/protocol";

/**
 * Schedules as people choose them in the form, and plain-English descriptions of any RRULE
 * or cron expression the daemon accepts (ADR 0015). Upcoming runs come from the daemon's own
 * recurrence engine, so the preview is what the daemon will do. Pure: no clock, no I/O.
 */
export const weekdays = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
export type Weekday = (typeof weekdays)[number];
const dayNames: Record<Weekday, string> = {
  MO: "Monday",
  TU: "Tuesday",
  WE: "Wednesday",
  TH: "Thursday",
  FR: "Friday",
  SA: "Saturday",
  SU: "Sunday",
};
export const weekdayName = (day: Weekday) => dayNames[day];

/** The IANA zone this browser runs in; new schedules are anchored to it. */
export const localTimeZone = () => new Intl.DateTimeFormat().resolvedOptions().timeZone;
const cronDays: readonly Weekday[] = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const workweek = "MO,TU,WE,TH,FR";

export type SchedulePreset =
  | { kind: "daily"; time: string }
  | { kind: "weekdays"; time: string }
  | { kind: "weekly"; day: Weekday; time: string }
  | { kind: "hourly"; every: number }
  | { kind: "custom"; syntax: "rrule" | "cron"; expression: string };

const pad = (value: number) => String(value).padStart(2, "0");
const clock = (hour: number, minute: number) => `${pad(hour)}:${pad(minute)}`;
const parseTime = (time: string): [number, number] => {
  const [hour = 0, minute = 0] = time.split(":").map(Number);
  return [hour, minute];
};
const at = (time: string) => {
  const [hour, minute] = parseTime(time);
  return `BYHOUR=${hour};BYMINUTE=${minute}`;
};

export function presetToSchedule(
  preset: SchedulePreset,
  timezone: string,
  startAt: number,
): AutomationSchedule {
  const base = { timezone, startAt: Math.floor(startAt / 60_000) * 60_000 };
  switch (preset.kind) {
    case "daily":
      return { ...base, kind: "rrule", expression: `FREQ=DAILY;${at(preset.time)}` };
    case "weekdays":
      return {
        ...base,
        kind: "rrule",
        expression: `FREQ=WEEKLY;BYDAY=${workweek};${at(preset.time)}`,
      };
    case "weekly":
      return {
        ...base,
        kind: "rrule",
        expression: `FREQ=WEEKLY;BYDAY=${preset.day};${at(preset.time)}`,
      };
    case "hourly":
      return {
        ...base,
        kind: "rrule",
        expression: `FREQ=HOURLY;INTERVAL=${preset.every};BYMINUTE=0`,
      };
    case "custom":
      return { ...base, kind: preset.syntax, expression: preset.expression.trim() };
  }
}

interface Rule {
  freq: string;
  /** Parts besides FREQ, INTERVAL, BYDAY, BYHOUR and BYMINUTE (COUNT, UNTIL, BYMONTHDAY…). */
  other: boolean;
  interval: number;
  days: string[] | undefined;
  hours: number[] | undefined;
  minutes: number[] | undefined;
}
/** Lenient RRULE read for display; the daemon is the validator. */
function readRule(expression: string): Rule | undefined {
  const fields = new Map<string, string>();
  for (const part of expression.replace(/^RRULE:/i, "").split(";")) {
    const [key, value] = part.split("=");
    if (key && value) fields.set(key.toUpperCase(), value.toUpperCase());
  }
  const freq = fields.get("FREQ");
  if (!freq) return undefined;
  const numbers = (key: string) => fields.get(key)?.split(",").map(Number);
  const presetParts = new Set(["FREQ", "INTERVAL", "BYDAY", "BYHOUR", "BYMINUTE"]);
  return {
    freq,
    other: [...fields.keys()].some((key) => !presetParts.has(key)),
    interval: Number(fields.get("INTERVAL") ?? 1),
    days: fields.get("BYDAY")?.split(","),
    hours: numbers("BYHOUR"),
    minutes: numbers("BYMINUTE"),
  };
}

export function scheduleToPreset(schedule: AutomationSchedule): SchedulePreset {
  const custom: SchedulePreset = {
    kind: "custom",
    syntax: schedule.kind,
    expression: schedule.expression,
  };
  if (schedule.kind !== "rrule") return custom;
  const rule = readRule(schedule.expression);
  // A preset can't carry COUNT, UNTIL or the like: such a rule stays exactly as written.
  if (!rule || rule.other) return custom;
  const single = rule.hours?.length === 1 && rule.minutes?.length === 1;
  const time = single ? clock(rule.hours?.[0] ?? 0, rule.minutes?.[0] ?? 0) : undefined;
  if (rule.freq === "DAILY" && rule.interval === 1 && !rule.days && time)
    return { kind: "daily", time };
  if (rule.freq === "WEEKLY" && rule.interval === 1 && time) {
    if (rule.days?.join(",") === workweek) return { kind: "weekdays", time };
    const day = rule.days?.length === 1 ? weekdays.find((d) => d === rule.days?.[0]) : undefined;
    if (day) return { kind: "weekly", day, time };
  }
  if (rule.freq === "HOURLY" && !rule.days && !rule.hours && rule.minutes?.join() === "0")
    return { kind: "hourly", every: rule.interval };
  return custom;
}

const plural = (count: number, word: string) =>
  count === 1 ? `every ${word}` : `every ${count} ${word}s`;
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const list = (items: readonly string[]) =>
  items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1) ?? ""}`;
const dayList = (days: readonly Weekday[]) =>
  days.join(",") === workweek ? "weekdays" : list(days.map((day) => `${dayNames[day]}s`));

/** The time of day a rule fires: BYHOUR/BYMINUTE, else the start instant's wall clock. */
function timeOfDay(rule: Rule, schedule: AutomationSchedule): string | undefined {
  if ((rule.hours?.length ?? 1) > 1 || (rule.minutes?.length ?? 1) > 1) return undefined;
  const local = wallClock(schedule.startAt, schedule.timezone);
  return clock(rule.hours?.[0] ?? local.hour, rule.minutes?.[0] ?? local.minute);
}

function wallClock(instant: number, timezone: string): { hour: number; minute: number } {
  try {
    return zonedCalendar(timezone).local(instant);
  } catch {
    return { hour: 0, minute: 0 };
  }
}

function describeRule(schedule: AutomationSchedule): string | undefined {
  const rule = readRule(schedule.expression);
  if (!rule) return undefined;
  const time = timeOfDay(rule, schedule);
  const suffix = time ? ` at ${time}` : "";
  const days = rule.days?.map((day) => weekdays.find((d) => d === day));
  if (days?.some((day) => day === undefined)) return undefined;
  const known = (days ?? []).filter((day): day is Weekday => day !== undefined);
  switch (rule.freq) {
    case "MINUTELY":
      return capital(plural(rule.interval, "minute"));
    case "HOURLY":
      return capital(plural(rule.interval, "hour"));
    case "DAILY":
      return `${capital(rule.interval === 1 ? "every day" : plural(rule.interval, "day"))}${suffix}`;
    case "WEEKLY":
      if (rule.interval === 1 && known.length) return `${capital(dayList(known))}${suffix}`;
      return `${capital(plural(rule.interval, "week"))}${known.length ? ` on ${dayList(known)}` : ""}${suffix}`;
    case "MONTHLY":
      return `${capital(rule.interval === 1 ? "every month" : plural(rule.interval, "month"))}${suffix}`;
    case "YEARLY":
      return `Every year${suffix}`;
    default:
      return undefined;
  }
}

const numeric = /^\d+$/;
const step = (field: string) => /^\*\/(\d+)$/.exec(field)?.[1];
const monthNames = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
/** "Day 1 of every month", "1 March every year": a cron with a day of month (and month). */
function describeCronDate(dom: string, month: string, dow: string): string | undefined {
  if (dow !== "*" || !numeric.test(dom) || Number(dom) < 1 || Number(dom) > 31) return undefined;
  if (month === "*") return `Day ${Number(dom)} of every month`;
  const name = numeric.test(month) ? monthNames[Number(month) - 1] : undefined;
  return name ? `${Number(dom)} ${name} every year` : undefined;
}
function describeCron(expression: string): string | undefined {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return undefined;
  const [minute = "", hour = "", dom = "", month = "", dow = ""] = fields;
  if (dom !== "*" || month !== "*") {
    if (!numeric.test(minute) || !numeric.test(hour)) return undefined;
    const date = describeCronDate(dom, month, dow);
    return date && `${date} at ${clock(Number(hour), Number(minute))}`;
  }
  if (step(minute) && hour === "*" && dow === "*")
    return capital(plural(Number(step(minute)), "minute"));
  if (numeric.test(minute) && step(hour) && dow === "*")
    return capital(plural(Number(step(hour)), "hour"));
  if (!numeric.test(minute) || !numeric.test(hour)) return undefined;
  const time = ` at ${clock(Number(hour), Number(minute))}`;
  if (dow === "*") return `Every day${time}`;
  const days = cronWeekdays(dow);
  return days ? `${capital(dayList(days))}${time}` : undefined;
}
function cronWeekdays(field: string): Weekday[] | undefined {
  const out: Weekday[] = [];
  for (const term of field.split(",")) {
    const [from = "", to = from] = term.split("-");
    if (!numeric.test(from) || !numeric.test(to)) return undefined;
    for (let n = Number(from); n <= Number(to); n++) {
      const day = cronDays[n % 7];
      if (!day) return undefined;
      if (!out.includes(day)) out.push(day);
    }
  }
  // Present Monday-first, the way people read a week.
  return out.toSorted((a, b) => weekdays.indexOf(a) - weekdays.indexOf(b));
}

/** "Every day at 02:00", "Weekdays at 09:30", "Every 6 hours"; the raw text when unusual. */
export function describeSchedule(schedule: AutomationSchedule): string {
  const text =
    schedule.kind === "rrule" ? describeRule(schedule) : describeCron(schedule.expression);
  return text ?? `${schedule.kind === "cron" ? "Cron" : "RRULE"} ${schedule.expression}`;
}

const githubEvents: Record<Extract<AutomationTrigger, { kind: "github" }>["event"], string> = {
  pr_changed: "a pull request opens or changes",
  ci_failed: "CI fails",
  review_comment: "a review comment arrives",
  issue_labelled: "an issue is labelled",
};
export const githubEventLabels = githubEvents;

export function describeTrigger(trigger: AutomationTrigger): string {
  switch (trigger.kind) {
    case "manual":
      return "Only when run by hand";
    case "schedule":
      return describeSchedule(trigger.schedule);
    case "github":
      return `When ${githubEvents[trigger.event]}${trigger.label ? ` (${trigger.label})` : ""} in ${trigger.repository}`;
    case "file":
      return `When ${list(trigger.paths)} change`;
  }
}

/** "When an issue is labelled (bug) in owner/name"; a schedule adds its zone when not local. */
export function describeWhen(trigger: AutomationTrigger, localZone: string): string {
  const text = describeTrigger(trigger);
  return trigger.kind === "schedule" && trigger.schedule.timezone !== localZone
    ? `${text} (${trigger.schedule.timezone})`
    : text;
}

const day = 86_400_000;
const hour = 3_600_000;

/** "Today 14:00", "Tonight 02:00", "Tomorrow 09:30", "Friday 16:00", "Oct 12 09:00"; in the requested zone. */
export function formatWhen(instant: number, now: number, timezone = localTimeZone()): string {
  const calendar = zonedCalendar(timezone);
  const target = calendar.local(instant);
  const today = calendar.local(now);
  const time = formatClock(instant, undefined, timezone);
  const midnight = (civil: typeof target) => civilStamp({ ...civil, hour: 0, minute: 0 });
  const days = (midnight(target) - midnight(today)) / day;
  if (days === 0) return `${target.hour >= 18 ? "Tonight" : "Today"} ${time}`;
  if (days === 1)
    return target.hour < 6 && today.hour >= 18 ? `Tonight ${time}` : `Tomorrow ${time}`;
  if (days === -1) return `Yesterday ${time}`;
  const date = new Date(instant);
  if (days > 0 && days < 7)
    return `${date.toLocaleDateString("en-US", { timeZone: timezone, weekday: "long" })} ${time}`;
  return `${date.toLocaleDateString("en-US", { timeZone: timezone, month: "short", day: "numeric" })} ${time}`;
}

/** "Tomorrow 02:00 · in 3h": the wall clock, and how far off it is within a day. */
export function formatNextRun(next: number, now: number, timezone = localTimeZone()): string {
  const diff = next - now;
  if (diff < 60_000) return "Any moment";
  const relative =
    diff < hour
      ? ` · in ${Math.round(diff / 60_000)}m`
      : diff < day
        ? ` · in ${Math.round(diff / hour)}h`
        : "";
  return `${formatWhen(next, now, timezone)}${relative}`;
}

/**
 * The next few starts of a schedule, by the daemon's own recurrence rules. Empty when the
 * expression can't be compiled: the daemon is the validator and says why on save.
 */
export function upcomingRuns(schedule: AutomationSchedule, after: number, count = 3): number[] {
  const runs: number[] = [];
  try {
    const recurrence = compileSchedule(schedule);
    let cursor = after;
    while (runs.length < count) {
      const next = recurrence.next(cursor);
      if (next === undefined) break;
      runs.push(next);
      cursor = next;
    }
  } catch {
    return runs;
  }
  return runs;
}

/** "Tue 7 Oct 09:00", in the schedule's zone. */
export function formatRunInZone(instant: number, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(instant);
    const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "";
    return `${part("weekday")} ${part("day")} ${part("month")} ${part("hour")}:${part("minute")}`;
  } catch {
    return new Date(instant).toISOString();
  }
}

/** Every IANA zone this browser knows, with `current` kept even if it doesn't. */
export function timeZones(current: string): string[] {
  const known =
    typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  return known.includes(current) ? known : [current, ...known];
}
