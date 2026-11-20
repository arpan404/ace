import { z } from "zod";
import { spadeJson, spadeRecord } from "./json.ts";

/*
 * How Spade reaches the person (ADR 0195), as `GET /v1/reach` sends it: notifications on or
 * off, do not disturb, a daily quiet window, the interruption budget, the morning brief and
 * spend alerts, with why proactive notices wait right now and how many do. Minutes are after
 * local midnight in the person's zone; money is in micros. Lenient: a field that doesn't read
 * takes Spade's default.
 */

const minute = z.number().int().min(0).max(1439);
const bound = z.number().int().positive().nullable().catch(null);
const shape = z.object({
  notify: z.boolean().catch(true).default(true),
  dnd: z.boolean().catch(false).default(false),
  quiet: z.object({ from: minute, to: minute }).nullable().catch(null).default(null),
  budget: z
    .object({ per_hour: bound.default(6), per_day: bound.default(30) })
    .catch({ per_hour: 6, per_day: 30 })
    .default({ per_hour: 6, per_day: 30 }),
  brief: z
    .object({
      on: z.boolean().catch(false).default(false),
      at: minute.catch(480).default(480),
      bots: z.array(z.string()).nullable().catch(null).default(null),
      polish: z.boolean().catch(false).default(false),
    })
    .catch({ on: false, at: 480, bots: null, polish: false })
    .default({ on: false, at: 480, bots: null, polish: false }),
  spend: z
    .object({
      on: z.boolean().catch(true).default(true),
      factor: z.number().int().catch(5).default(5),
      floor_micros: z.number().int().nonnegative().catch(1_000_000).default(1_000_000),
    })
    .catch({ on: true, factor: 5, floor_micros: 1_000_000 })
    .default({ on: true, factor: 5, floor_micros: 1_000_000 }),
});

export interface SpadeReach {
  notify: boolean;
  dnd: boolean;
  /** The daily quiet window; null for none. */
  quiet: { from: number; to: number } | null;
  perHour: number | null;
  perDay: number | null;
  brief: { on: boolean; at: number; bots: string[] | null; polish: boolean };
  spend: { on: boolean; factor: number; floorMicros: number };
  /** Why proactive notices wait right now: `dnd`, `quiet`, or undefined when they don't. */
  waitingFor: "dnd" | "quiet" | undefined;
  /** How many notices wait for the next digest or brief. */
  held: number;
}

/** `GET` and `PUT /v1/reach`; undefined when the body has no settings. */
export function parseSpadeReach(body: string): SpadeReach | undefined {
  const record = spadeRecord(spadeJson(body));
  const parsed = shape.safeParse(record?.settings);
  if (!record || !parsed.success) return undefined;
  const s = parsed.data;
  const quiet = record.quiet;
  return {
    notify: s.notify,
    dnd: s.dnd,
    quiet: s.quiet,
    perHour: s.budget.per_hour,
    perDay: s.budget.per_day,
    brief: s.brief,
    spend: { on: s.spend.on, factor: s.spend.factor, floorMicros: s.spend.floor_micros },
    waitingFor: quiet === "dnd" || quiet === "quiet" ? quiet : undefined,
    held: typeof record.held === "number" ? record.held : 0,
  };
}

/** `14:30` from minutes after midnight, as an `<input type="time">` holds it. */
export function spadeClock(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Minutes after midnight from `14:30`; undefined for anything else. */
export function spadeMinutes(clock: string): number | undefined {
  const match = /^(\d{2}):(\d{2})$/.exec(clock);
  if (!match) return undefined;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return minutes < 1440 ? minutes : undefined;
}
