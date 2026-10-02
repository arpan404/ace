import { z } from "zod";

export function integers(value: string, min: number, max: number): number[] {
  const result = value.split(",").map((part) => {
    if (!/^\d+$/.test(part)) throw new Error("Expected an unsigned integer list");
    return z.number().int().min(min).max(max).parse(Number(part));
  });
  return [...new Set(result)].toSorted((a, b) => a - b);
}
export function cronField(value: string, min: number, max: number): number[] {
  const values = new Set<number>();
  for (const term of value.split(",")) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(term);
    if (!match?.[1]) throw new Error("Invalid cron field");
    const step = match[2] === undefined ? 1 : integers(match[2], 1, max - min + 1)[0];
    if (step === undefined) throw new Error("Invalid step");
    let low = min,
      high = max;
    if (match[1] !== "*") {
      const [a, b] = match[1].split("-");
      low = integers(a ?? "", min, max)[0] ?? min;
      high = b === undefined ? low : (integers(b, min, max)[0] ?? max);
      if (low > high || (match[2] !== undefined && b === undefined))
        throw new Error("Invalid cron range");
    }
    for (let n = low; n <= high; n += step) values.add(n);
  }
  return [...values].toSorted((a, b) => a - b);
}
const Frequency = z.enum(["MINUTELY", "HOURLY", "DAILY", "WEEKLY", "MONTHLY", "YEARLY"]);
const weekdays = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
export interface DayRule {
  weekday: number;
  ordinal: number | undefined;
}
export interface Rule {
  frequency: z.infer<typeof Frequency>;
  interval: number;
  days: DayRule[] | undefined;
  hours: number[] | undefined;
  minutes: number[] | undefined;
  count: number | undefined;
  until: number | undefined;
}
export function parseRule(expression: string): Rule {
  const fields = new Map<string, string>();
  for (const part of expression.replace(/^RRULE:/, "").split(";")) {
    const [key, value, ...extra] = part.split("=");
    if (
      !key ||
      !value ||
      extra.length ||
      fields.has(key) ||
      !["FREQ", "INTERVAL", "BYDAY", "BYHOUR", "BYMINUTE", "COUNT", "UNTIL"].includes(key)
    )
      throw new Error("Invalid or unsupported RRULE field");
    fields.set(key, value);
  }
  const frequency = Frequency.parse(fields.get("FREQ"));
  const number = (key: string, min: number, max: number) => {
    const value = fields.get(key);
    return value === undefined ? undefined : integers(value, min, max);
  };
  const scalar = (key: string) => {
    const result = number(key, 1, 1_000_000);
    if (result && result.length !== 1) throw new Error("Expected scalar");
    return result?.[0];
  };
  const days = fields
    .get("BYDAY")
    ?.split(",")
    .map((value): DayRule => {
      const m = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(value);
      if (!m) throw new Error("Invalid BYDAY");
      const ordinal = m[1] === undefined ? undefined : Number(m[1]);
      if (
        ordinal !== undefined &&
        (!ordinal || Math.abs(ordinal) > 53 || !["MONTHLY", "YEARLY"].includes(frequency))
      )
        throw new Error("Invalid BYDAY ordinal");
      return { weekday: weekdays.indexOf(m[2] ?? ""), ordinal };
    });
  const count = scalar("COUNT");
  let until: number | undefined;
  const value = fields.get("UNTIL");
  if (value !== undefined) {
    if (count !== undefined) throw new Error("COUNT and UNTIL are mutually exclusive");
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
    if (!m) throw new Error("UNTIL must be a UTC date-time");
    const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z`;
    until = Date.parse(iso);
    if (!Number.isFinite(until) || new Date(until).toISOString() !== iso)
      throw new Error("Invalid UNTIL");
  }
  return {
    frequency,
    interval: scalar("INTERVAL") ?? 1,
    days,
    hours: number("BYHOUR", 0, 23),
    minutes: number("BYMINUTE", 0, 59),
    count,
    until,
  };
}
